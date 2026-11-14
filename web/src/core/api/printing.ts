/**
 * Drucker und Etiketten (`Core.printers`, `Core.print`).
 *
 * Anfordern, Verwerfen und die Antwort auf „Wurde gedruckt?" sind Befehle des Sync
 * (`printer.*`, `print.*`) und gelingen auch offline. Das Zustellen an die Druckdienste, das
 * Abfragen eines Druckers und der Notweg stehen in src/core/print; hier hängen sie an der
 * Schnittstelle (docs/etiketten.md, Abschnitte 4 und 5).
 */
import type { PrinterChanges, PrintJob } from "@/contract/api.gen";
import { MAX_HANDOFF_JOBS, type NewPrinter, type PrintApi, type PrintersApi, type PrintFlushReport } from "@/contract/core";
import { CoreError } from "@/contract/errors";
import { newUuid } from "@/contract/ids";
import { ROUTES } from "@/contract/routes";

import type { DeliveryEntry } from "../db";
import { baseOf } from "../print/address";
import { byRequestOrder, labelData, labelIdsInOrder, printerFor, templateFor } from "../print/content";
import { PRINT_TEXTS } from "../print/texts";
import type { Mutation } from "../store";
import type { Tables } from "../tables";
import { toCoreError, type CoreRuntime, type PrintRuntime } from "./runtime";
import { activePrinter, activeZone, checkDirectConfig, checkServerConfig, existingPackages, invalid, LIMITS, notFound, requiredText, requirePrinter } from "./validate";

export function createPrintersApi(runtime: CoreRuntime, print: PrintRuntime): PrintersApi {
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

    async probe(id: string) {
      await runtime.ready;
      const state = runtime.store.snapshot;
      const printer = state.view.printers.get(id);
      const unsynced = state.outbox.some(({ command }) => (command.type === "printer.create" || command.type === "printer.update") && command.printer_id === id);
      if (printer?.connection === "server" && unsynced) {
        // Einen eben angelegten oder geänderten Drucker kennt der Server erst nach dem Abgleich;
        // sonst hieße es gleich nach dem Anlegen „Der Server kennt diesen Drucker nicht". Ein
        // langsamer Abgleich hält die Abfrage höchstens 10 Sekunden auf.
        await print.syncFirst();
      }
      let result;
      try {
        result = await print.engine.probe(id);
      } catch (error) {
        throw toCoreError(error);
      }
      if (result.reachable) {
        // Der Drucker ist da: Was für ihn aussteht, geht jetzt hin.
        print.afterProbe();
      }
      return result;
    },
  };
}

function requestJob(mutation: Mutation, subject: { package_id: string } | { zone_id: string }, printerId: string | null, jobId: string = newUuid()): PrintJob {
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
    throw notFound(PRINT_TEXTS.no_job);
  }
  return job;
}

/** Der ausdrücklich gewählte Drucker oder null. */
function chosenPrinter(mutation: Mutation, printerId: string | null | undefined): string | null {
  return printerId === null || printerId === undefined ? null : activePrinter(mutation.draft, printerId).id;
}

/** UTF-8 als Base64 in der URL-Form: `-` und `_`, ohne `=`. */
function base64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Die Adresse der Drucker-Ansicht dieser App, für „Zurück zu Stowly" auf der Seite des Druckdienstes. */
function backAddress(): string | null {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return typeof origin === "string" && /^https?:\/\//.test(origin) ? `${origin}${ROUTES.printers}` : null;
}

export function createPrintApi(runtime: CoreRuntime, print: PrintRuntime): PrintApi {
  const view = (): Tables => runtime.store.snapshot.view;

  return {
    requestPackageLabels(packageIds: string[], options?: { printer_id?: string | null }) {
      return runtime.change((mutation) => {
        const packages = existingPackages(mutation.draft, packageIds);
        requirePrinter(mutation.draft);
        const printerId = chosenPrinter(mutation, options?.printer_id);
        // Aufsteigende Kennungen: So kommen die Etiketten in der Reihenfolge der Packungen aus dem Drucker.
        const ids = labelIdsInOrder(packages.length);
        return packages.map((pkg, index) => requestJob(mutation, { package_id: pkg.id }, printerId, ids[index]));
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
        // Ein ausstehendes Etikett eines anderen Geräts übernehmen („hier drucken"): Das alte
        // wird verworfen, ein eigenes entsteht. Zustellen kann immer nur das Gerät, das angefordert hat.
        const takeOver = old.state === "pending" && old.device_id !== mutation.deviceId;
        if (!takeOver && old.state !== "failed" && old.state !== "unknown" && old.state !== "cancelled") {
          throw invalid("Nur fehlgeschlagene, unklare oder verworfene Etiketten lassen sich wiederholen.");
        }
        if (takeOver) {
          mutation.emit({ type: "print.report", job_id: old.id, state: "cancelled", printer_id: old.printer_id, boot_id: old.boot_id, error: null });
        }
        // Ein neuer Versuch ist ein neues Etikett; das alte bleibt, wie es ist. Ein inzwischen
        // gelöschter Drucker gilt als nicht gewählt.
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

    async cancel(jobId: string) {
      await runtime.ready;
      const known = view().print_jobs.get(jobId);
      if (known && (known.state === "pending" || known.state === "queued") && print.engine.needsServiceCancel(known)) {
        // Ein eigenes Etikett, das beim Druckdienst wartet (oder dorthin unterwegs sein kann),
        // wird zuerst dort verworfen: Sonst druckte es trotzdem.
        try {
          await print.engine.cancelAtService(jobId);
        } catch (error) {
          throw toCoreError(error);
        }
        return;
      }
      await runtime.change((mutation) => {
        const job = existingJob(mutation, jobId);
        if (job.state !== "pending" && job.state !== "queued") {
          throw invalid("Das Etikett ist nicht mehr ausstehend.");
        }
        mutation.dropDelivery(job.id);
        mutation.emit({ type: "print.report", job_id: job.id, state: "cancelled", printer_id: job.printer_id, boot_id: job.boot_id, error: null });
      });
    },

    resolveUnknown(jobId: string, printed: boolean) {
      return runtime.change((mutation) => {
        const job = existingJob(mutation, jobId);
        if (job.state !== "unknown") {
          throw invalid("Bei diesem Etikett ist nichts offen.");
        }
        // Der Anwender hat entschieden: Beim Dienst wird nicht mehr nachgefragt.
        mutation.dropDelivery(job.id);
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

    async flush(): Promise<PrintFlushReport> {
      try {
        await runtime.ready;
        // An einen Drucker am Server geht ein Etikett erst, wenn seine Anforderung abgeglichen ist
        // (docs/etiketten.md, 4.1). Wer „jetzt drucken" sagt, meint das mit: erst abgleichen, aber
        // höchstens 10 Sekunden lang. Was der Server danach noch nicht kennt, bleibt ausstehend und
        // geht hinaus, sobald der Abgleich fertig ist.
        const state = runtime.store.snapshot;
        const deviceId = state.session?.status === "signed_in" ? state.session.device?.id : undefined;
        const waitsForSync = state.outbox.some(({ command }) => {
          if (command.type !== "print.request") {
            return false;
          }
          const job = state.view.print_jobs.get(command.job_id);
          const printerId = job && job.device_id === deviceId && job.state === "pending" ? printerFor(state.view, job) : null;
          return printerId !== null && state.view.printers.get(printerId)?.connection === "server";
        });
        if (waitsForSync) {
          await print.syncFirst();
        }
        const { delivered, pending, problems } = await print.flush();
        return { delivered, pending, problems };
      } catch {
        // `flush` wirft nie.
        return { delivered: 0, pending: 0, problems: [] };
      }
    },

    async preview(subject, options) {
      await runtime.ready;
      const current = view();
      const kind = subject.kind;
      const data = labelData(current, kind === "package" ? { package_id: subject.package_id, zone_id: null } : { package_id: null, zone_id: subject.zone_id });
      if (!data) {
        throw notFound(kind === "package" ? "Die Packung gibt es nicht." : "Die Zone gibt es nicht.");
      }
      const template = templateFor(current, kind);
      if (!template) {
        throw notFound(PRINT_TEXTS.no_template);
      }
      const body: { template: Record<string, unknown>; data: Record<string, string>; printer?: string } = { template, data };
      const printerId = options?.printer_id;
      if (printerId !== null && printerId !== undefined) {
        const printer = current.printers.get(printerId);
        if (!printer || printer.deleted_at !== null) {
          throw notFound("Den Drucker gibt es nicht.");
        }
        // Nur ein Drucker am Server hat dort eine Größe; sonst gilt die Vorgabe (62 mm bei 300 dpi).
        if (printer.connection === "server") {
          body.printer = printer.id;
        }
      }
      return runtime.server(async (token) => {
        const reply = await print.client.render({ kind: "server", token }, body);
        if (reply.ok) {
          return reply.value;
        }
        if (!reply.reached) {
          throw new CoreError("offline", PRINT_TEXTS.preview_offline);
        }
        switch (reply.code) {
          case "unauthorized":
            throw new CoreError("unauthorized", "Dieses Gerät ist nicht angemeldet.");
          case "unknown_printer":
          case "not_found":
            throw notFound("Der Server kennt diesen Drucker nicht.");
          case "not_implemented":
            throw new CoreError("not_supported", reply.message);
          default:
            throw invalid(PRINT_TEXTS.preview_failed);
        }
      });
    },

    async image(jobId: string) {
      await runtime.ready;
      try {
        return await print.engine.image(jobId);
      } catch (error) {
        throw toCoreError(error);
      }
    },

    handoff(printerId: string) {
      return runtime.change((mutation) => {
        const printer = activePrinter(mutation.draft, printerId);
        if (printer.connection !== "direct" || !printer.direct) {
          throw invalid(PRINT_TEXTS.handoff_only_direct);
        }
        const current = mutation.state.view;
        const deviceId = mutation.deviceId;
        /** Eigene ausstehende Etiketten dieses Druckers, die vielleicht schon unterwegs sind. */
        let maybeSent = 0;
        const waiting = [...current.print_jobs.values()]
          .filter((job) => {
            if (job.state !== "pending" || deviceId === null || job.device_id !== deviceId) {
              return false;
            }
            const entry = mutation.delivery(job.id);
            if (entry && entry.phase !== "handoff") {
              // Schon einmal abgeschickt: Die Seite des Dienstes reichte es mit der `boot_id` ein,
              // die sie selbst eben gesehen hat; nach einem Neustart des Pi druckte es dann
              // vielleicht ein zweites Mal. Es bleibt stehen und wird auf dem normalen Weg geklärt.
              if (entry.printer_id === printer.id) {
                maybeSent += 1;
              }
              return false;
            }
            return printerFor(current, job) === printer.id;
          })
          .sort(byRequestOrder);
        // Eine Übergabe trägt genau eine Vorlage: nur Etiketten der Art des ältesten.
        const kind = waiting[0]?.kind;
        const template = kind ? templateFor(current, kind) : null;
        const jobs: { id: string; data: Record<string, string> }[] = [];
        for (const job of waiting) {
          if (jobs.length >= MAX_HANDOFF_JOBS) {
            break;
          }
          if (job.kind !== kind) {
            continue;
          }
          const data = labelData(current, job);
          if (data) {
            jobs.push({ id: job.id, data });
          }
        }
        if (jobs.length === 0 || !template) {
          if (waiting.length === 0 && maybeSent > 0) {
            throw notFound(PRINT_TEXTS.handoff_maybe_sent);
          }
          throw notFound(template || waiting.length === 0 ? PRINT_TEXTS.handoff_nothing : PRINT_TEXTS.no_template);
        }
        // Die Seite liefert der Dienst selbst aus; über HTTP braucht sie kein Zertifikat.
        const base = baseOf(printer.direct.urls.find((url) => url.startsWith("http://")) ?? printer.direct.urls[0] ?? "");
        const payload = { v: 1, token: printer.direct.token, printer: printer.direct.printer, template, jobs, back: backAddress() };
        const handed: PrintJob[] = [];
        for (const { id } of jobs) {
          // Den Ausgang erfährt die App nicht: Sie fragt nach („Wurde das Etikett gedruckt?").
          const entry: DeliveryEntry = { job_id: id, printer_id: printer.id, url: base, boot_id: null, content: null, phase: "handoff", created_at: mutation.at };
          mutation.putDelivery(entry);
          mutation.emit({ type: "print.report", job_id: id, state: "unknown", printer_id: printer.id, boot_id: null, error: "handoff" });
          const job = mutation.draft.get("print_jobs", id);
          if (job) {
            handed.push(job);
          }
        }
        return { url: `${base}/p#${base64Url(JSON.stringify(payload))}`, jobs: handed };
      });
    },
  };
}
