import { useCallback, useState } from "react";

import { isCoreError, useCore, type Printer, type PrintFlushReport } from "@/contract";
import { errorText, plural } from "@/ui";
import { useToast } from "@/ui/base";

import type { JobView } from "./model";

export interface LabelActions {
  /** Was gerade läuft: die Kennung eines Etiketts, "flush", "all" oder "handoff:<Drucker>"; sonst null. */
  busy: string | null;
  /** Verwirft ein ausstehendes Etikett. */
  cancel(view: JobView): Promise<void>;
  /** Neuer Versuch (immer ein neues Etikett); bei einem fremden ausstehenden: hier drucken. */
  retry(view: JobView): Promise<void>;
  /** Antwort auf „Wurde das Etikett gedruckt?". */
  resolve(view: JobView, printed: boolean): Promise<void>;
  /** „Alle gedruckt" für mehrere unklare Etiketten zugleich. */
  resolveAll(views: readonly JobView[]): Promise<void>;
  /** Stellt die eigenen ausstehenden Etiketten jetzt zu; null, wenn schon der Aufruf scheitert. */
  flush(): Promise<PrintFlushReport | null>;
  /** Notweg: übergibt die ausstehenden Etiketten an die Seite des Druckdienstes und öffnet sie. */
  handoff(printer: Printer): Promise<void>;
  /** Die Seite des Druckdienstes ließ sich nicht von selbst öffnen (der Browser hat das Fenster blockiert). */
  blocked: { url: string; printer: Printer } | null;
}

/**
 * Was sich mit Etiketten tun lässt, mit den Meldungen dazu. Gemeinsam für die Drucker-Ansicht
 * und die Nachfrage im Rahmen der App.
 *
 * `flush` und `handoff` sprechen den Druckdienst an und können die Nachfrage des Browsers
 * nach dem lokalen Netzwerk auslösen: Beide laufen nur auf eine Handlung des Anwenders hin.
 */
export function useLabelActions(): LabelActions {
  const core = useCore();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ url: string; printer: Printer } | null>(null);

  const run = useCallback(
    async (key: string, action: () => Promise<void>, texts: Parameters<typeof errorText>[1] = {}) => {
      setBusy(key);
      try {
        await action();
      } catch (error) {
        toast.show({ message: errorText(error, texts), tone: "danger" });
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const retry = useCallback(
    (view: JobView) => {
      // Ein ausstehendes Etikett eines anderen Geräts: Der Kern verwirft es und legt ein eigenes an.
      const takeOver = view.job.state === "pending" && !view.own;
      return run(
        view.job.id,
        async () => {
          await core.print.retry(view.job.id);
          toast.show({
            message: takeOver ? "Übernommen: Dieses Gerät druckt das Etikett jetzt." : "Neues Etikett angefordert",
            tone: "success",
          });
        },
        { not_found: "Dieses Etikett gibt es nicht mehr." },
      );
    },
    [core, run, toast],
  );

  const cancel = useCallback(
    (view: JobView) =>
      run(
        view.job.id,
        async () => {
          await core.print.cancel(view.job.id);
          toast.show({ message: "Etikett verworfen" });
        },
        {
          not_found: "Dieses Etikett gibt es nicht mehr.",
          offline: "Das Etikett wartet schon beim Drucker, und der ist gerade nicht erreichbar. Bitte später noch einmal versuchen.",
        },
      ),
    [core, run, toast],
  );

  const resolve = useCallback(
    (view: JobView, printed: boolean) =>
      run(
        view.job.id,
        async () => {
          await core.print.resolveUnknown(view.job.id, printed);
          if (printed) {
            toast.show({ message: "Als gedruckt vermerkt", tone: "success", duration: 3000 });
          } else {
            toast.show({
              id: `not-printed-${view.job.id}`,
              message: "Als nicht gedruckt vermerkt",
              duration: 10_000,
              action: { label: "Erneut drucken", onAction: () => void retry(view) },
            });
          }
        },
        { not_found: "Dieses Etikett gibt es nicht mehr." },
      ),
    [core, retry, run, toast],
  );

  const resolveAll = useCallback(
    (views: readonly JobView[]) =>
      run("all", async () => {
        for (const view of views) {
          await core.print.resolveUnknown(view.job.id, true);
        }
        toast.show({ message: `${plural(views.length, "Etikett", "Etiketten")} als gedruckt vermerkt`, tone: "success" });
      }),
    [core, run, toast],
  );

  const flush = useCallback(async (): Promise<PrintFlushReport | null> => {
    setBusy("flush");
    try {
      return await core.print.flush();
    } catch (error) {
      toast.show({ message: errorText(error), tone: "danger" });
      return null;
    } finally {
      setBusy(null);
    }
  }, [core, toast]);

  const handoff = useCallback(
    async (printer: Printer) => {
      // Das neue Fenster muss unmittelbar im Klick entstehen; nach dem Warten auf den Kern blockt der Browser es.
      const tab = window.open("about:blank", "_blank");
      setBlocked(null);
      setBusy(`handoff:${printer.id}`);
      try {
        const { url, jobs } = await core.print.handoff(printer.id);
        if (tab) {
          // Die Seite des Pi soll nicht auf diese App zurückgreifen können.
          tab.opener = null;
          tab.location.replace(url);
        } else {
          setBlocked({ url, printer });
        }
        toast.show({
          message: `${plural(jobs.length, "Etikett", "Etiketten")} an die Seite des Druckers übergeben. Stowly fragt danach, ob gedruckt wurde.`,
          duration: 8000,
        });
      } catch (error) {
        tab?.close();
        // Bei "not_found" sagt der Kern, warum nichts übergeben wird; auch, wenn die ausstehenden
        // Etiketten vielleicht schon beim Drucker sind (core.ts, `print.handoff`).
        const reason = isCoreError(error) && error.code === "not_found" && error.message.trim() !== "" && error.message !== error.code ? error.message : null;
        toast.show({
          message: reason ?? errorText(error, { not_found: "Für diesen Drucker steht kein eigenes Etikett aus.", invalid: "Die Seite des Druckdienstes gibt es nur bei einem direkten Drucker." }),
          tone: "danger",
        });
      } finally {
        setBusy(null);
      }
    },
    [core, toast],
  );

  return { busy, cancel, retry, resolve, resolveAll, flush, handoff, blocked };
}
