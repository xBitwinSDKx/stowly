/**
 * Drucker und Etiketten (`Core.printers`, `Core.print`). In Runde 1 nur die Datenhaltung:
 * Die Befehle `printer.*` und `print.*` entstehen und werden abgeglichen, zugestellt wird
 * noch nichts. Etiketten bleiben deshalb "pending" (docs/etiketten.md, Abschnitt 4).
 */
import type { PrinterChanges, PrintJob } from "@/contract/api.gen";
import type { NewPrinter, PrintApi, PrintersApi } from "@/contract/core";
import { CoreError } from "@/contract/errors";
import { newUuid } from "@/contract/ids";

import type { Mutation } from "../store";
import type { CoreRuntime } from "./runtime";
import { activePrinter, activeZone, checkDirectConfig, checkServerConfig, existingPackages, invalid, LIMITS, notFound, requiredText, requirePrinter } from "./validate";

const ROUND_2 = "Das Zustellen der Etiketten an die Druckdienste folgt in Runde 2.";

export function createPrintersApi(runtime: CoreRuntime): PrintersApi {
  return {
    create(input: NewPrinter) {
      return runtime.change((mutation) => {
        const name = requiredText(input.name, LIMITS.printer_name, "Der Drucker");
        const id = newUuid();
        if (input.connection === "server") {
          checkServerConfig(input.server);
          mutation.emit({ type: "printer.create", printer_id: id, name, connection: "server", server: input.server });
        } else if (input.connection === "direct") {
          checkDirectConfig(input.direct);
          mutation.emit({ type: "printer.create", printer_id: id, name, connection: "direct", direct: input.direct });
        } else {
          throw invalid("Unbekannte Art der Verbindung.");
        }
        const printer = mutation.draft.get("printers", id);
        if (!printer) {
          throw new CoreError("internal", "Der Drucker ließ sich nicht anlegen.");
        }
        return printer;
      });
    },

    update(id: string, changes: PrinterChanges) {
      return runtime.change((mutation) => {
        const printer = activePrinter(mutation.draft, id);
        const wanted: PrinterChanges = {};
        if (changes.name !== undefined) {
          wanted.name = requiredText(changes.name, LIMITS.printer_name, "Der Drucker");
        }
        if ((changes.server !== undefined && printer.connection !== "server") || (changes.direct !== undefined && printer.connection !== "direct")) {
          throw invalid("Die Art der Verbindung lässt sich nicht ändern.");
        }
        if (changes.server !== undefined) {
          checkServerConfig(changes.server);
          wanted.server = changes.server;
        }
        if (changes.direct !== undefined) {
          checkDirectConfig(changes.direct);
          wanted.direct = changes.direct;
        }
        if (Object.keys(wanted).length > 0) {
          mutation.emit({ type: "printer.update", printer_id: printer.id, changes: wanted });
        }
      });
    },

    remove(id: string) {
      return runtime.change((mutation) => {
        const printer = activePrinter(mutation.draft, id);
        mutation.emit({ type: "printer.delete", printer_id: printer.id });
      });
    },

    async probe() {
      throw new CoreError("not_supported", ROUND_2);
    },
  };
}

function requestJob(mutation: Mutation, subject: { package_id: string } | { zone_id: string }, printerId: string | null): PrintJob {
  const jobId = newUuid();
  if ("package_id" in subject) {
    mutation.emit({ type: "print.request", job_id: jobId, kind: "package", package_id: subject.package_id, printer_id: printerId });
  } else {
    mutation.emit({ type: "print.request", job_id: jobId, kind: "zone", zone_id: subject.zone_id, printer_id: printerId });
  }
  const job = mutation.draft.get("print_jobs", jobId);
  if (!job) {
    throw new CoreError("internal", "Das Etikett ließ sich nicht anfordern.");
  }
  return job;
}

function existingJob(mutation: Mutation, jobId: string): PrintJob {
  const job = mutation.draft.get("print_jobs", jobId);
  if (!job) {
    throw notFound("Das Etikett gibt es nicht.");
  }
  return job;
}

/** Der ausdrücklich gewählte Drucker oder null. */
function chosenPrinter(mutation: Mutation, printerId: string | null | undefined): string | null {
  return printerId === null || printerId === undefined ? null : activePrinter(mutation.draft, printerId).id;
}

export function createPrintApi(runtime: CoreRuntime): PrintApi {
  return {
    requestPackageLabels(packageIds: string[], options?: { printer_id?: string | null }) {
      return runtime.change((mutation) => {
        const packages = existingPackages(mutation.draft, packageIds);
        requirePrinter(mutation.draft);
        const printerId = chosenPrinter(mutation, options?.printer_id);
        return packages.map((pkg) => requestJob(mutation, { package_id: pkg.id }, printerId));
      });
    },

    requestZoneLabel(zoneId: string, options?: { printer_id?: string | null }) {
      return runtime.change((mutation) => {
        const zone = activeZone(mutation.draft, zoneId);
        requirePrinter(mutation.draft);
        return requestJob(mutation, { zone_id: zone.id }, chosenPrinter(mutation, options?.printer_id));
      });
    },

    retry(jobId: string) {
      return runtime.change((mutation) => {
        const old = existingJob(mutation, jobId);
        if (old.state !== "failed" && old.state !== "unknown" && old.state !== "cancelled") {
          throw invalid("Nur fehlgeschlagene, unklare oder verworfene Etiketten lassen sich wiederholen.");
        }
        // Ein neuer Versuch ist ein neues Etikett; das alte bleibt, wie es ist.
        const printer = old.printer_id === null ? undefined : mutation.draft.get("printers", old.printer_id);
        const printerId = printer && printer.deleted_at === null ? printer.id : null;
        if (old.package_id !== null) {
          return requestJob(mutation, { package_id: old.package_id }, printerId);
        }
        if (old.zone_id !== null) {
          return requestJob(mutation, { zone_id: old.zone_id }, printerId);
        }
        throw invalid("Das Etikett gehört zu nichts mehr.");
      });
    },

    cancel(jobId: string) {
      return runtime.change((mutation) => {
        const job = existingJob(mutation, jobId);
        if (job.state !== "pending" && job.state !== "queued") {
          throw invalid("Das Etikett ist nicht mehr ausstehend.");
        }
        mutation.emit({ type: "print.report", job_id: job.id, state: "cancelled", printer_id: job.printer_id, boot_id: job.boot_id, error: null });
      });
    },

    resolveUnknown(jobId: string, printed: boolean) {
      return runtime.change((mutation) => {
        const job = existingJob(mutation, jobId);
        if (job.state !== "unknown") {
          throw invalid("Bei diesem Etikett ist nichts offen.");
        }
        mutation.emit({
          type: "print.report",
          job_id: job.id,
          state: printed ? "printed" : "failed",
          printer_id: job.printer_id,
          boot_id: job.boot_id,
          error: printed ? null : "not_printed",
        });
      });
    },

    async flush() {
      // Runde 2: Etiketten zustellen. Bis dahin bleiben sie "pending".
      return { delivered: 0, pending: 0, problems: [] };
    },

    async preview() {
      throw new CoreError("not_supported", ROUND_2);
    },

    async image() {
      throw new CoreError("not_supported", ROUND_2);
    },

    async handoff() {
      throw new CoreError("not_supported", ROUND_2);
    },
  };
}
