import { useEffect, useRef, useState } from "react";

import { useCore, type Printer, type PrintFlushReport } from "@/contract";
import { EmptyState, Notice, plural, Section, timeAgo } from "@/ui";
import { Badge, Button, cx, Dialog } from "@/ui/base";
import { CircleCheckIcon, ExternalLinkIcon, ImageIcon, LabelsIcon, PrinterIcon, QuestionIcon, RetryIcon } from "@/ui/icons";

import type { LabelActions } from "./labelActions";
import { LabelImage } from "./LabelImage";
import { flushSummary, JOB_STATES, jobErrorText, type JobView } from "./model";
import { ProblemNotice } from "./PrinterCard";
import styles from "./PrintersPage.module.css";
import type { Printing } from "./usePrinting";

/** So viele erledigte Etiketten zeigt der Verlauf zunächst; mehr auf Wunsch. */
const HISTORY_STEP = 12;
/** So lange nach einem Klick an einer Zeile zieht der Fokus mit, wenn die Zeile ihren Platz wechselt. */
const FOLLOW_MS = 5000;

export interface LabelsProps {
  printing: Printing;
  actions: LabelActions;
  /** Jetzt, in Millisekunden (`useNow`). */
  now: number;
  /** Springt zur Zuordnung der Drucker. */
  onAssign: () => void;
}

/** Der Drucker eines Etiketts in Worten. Nur solange es aussteht, ist „kein Drucker" eine Auskunft; danach wird sie ausgelassen. */
function printerName(view: JobView): string {
  if (view.printer) {
    return view.printer.name;
  }
  return view.job.state === "pending" ? "kein Drucker zugeordnet" : "";
}

/** Eigene ausstehende Etiketten, die an diesen Drucker gingen. */
export function pendingFor(printing: Printing, printer: Printer): number {
  return printing.ownPending.filter((view) => view.printer?.id === printer.id).length;
}

/** Bild eines Etiketts, das ein Drucker mit Bild-Treiber geschrieben hat. */
function ImageDialog({ view, onClose }: { view: JobView; onClose: () => void }) {
  const core = useCore();
  return (
    <Dialog open onClose={onClose} title="Gedrucktes Etikett" variant="sheet" footer={<Button onClick={onClose}>Schließen</Button>}>
      <div className={styles.form}>
        <LabelImage
          load={() => core.print.image(view.job.id)}
          source={view.job.id}
          alt={`Etikett: ${view.title}`}
          offlineText="Das Bild liegt beim Server, und der ist gerade nicht erreichbar."
        />
        <p className={styles.muted}>
          {view.title}
          {view.detail !== "" ? ` · ${view.detail}` : ""}. So hat der Drucker „{printerName(view)}“ das Etikett geschrieben.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * Die Etiketten des Haushalts: was zu klären ist, was aussteht und der Verlauf der letzten 30 Tage.
 */
export function Labels({ printing, actions, now, onAssign }: LabelsProps) {
  const [report, setReport] = useState<PrintFlushReport | null>(null);
  const [shown, setShown] = useState(HISTORY_STEP);
  const [viewing, setViewing] = useState<string | null>(null);

  const done = printing.jobs.filter((view) => view.group === "done");
  const viewed = viewing === null ? undefined : printing.jobs.find((view) => view.job.id === viewing);
  // „Jetzt drucken" zählt nur, was einen Drucker hat: Der Rest steht mit „Zur Zuordnung" in der Liste.
  const own = printing.ownPending.filter((view) => view.printer !== undefined).length;
  const ownDirect = printing.ownPending.some((view) => view.printer?.connection === "direct");

  // Der Bericht gilt für einen Versuch. Steht inzwischen weniger aus, als er nennt (der Pi kam in
  // Reichweite, ein Etikett wurde verworfen), stimmt er nicht mehr und verschwindet.
  if (report && report.pending > 0 && printing.ownPending.length < report.pending) {
    setReport(null);
  }

  async function flush() {
    setReport(null);
    setReport(await actions.flush());
  }

  // Eine Antwort oder ein Verwerfen räumt die Zeile weg und mit ihr die Schaltfläche, die den Fokus
  // hatte. Damit er nicht verloren geht: weiter zur selben Packung an ihrem neuen Platz („Erneut
  // drucken" nach einem Nein), sonst zur nächsten Nachfrage, sonst zur ersten Schaltfläche hier.
  const acted = useRef<{ id: string; at: number } | null>(null);
  const jobsKey = printing.jobs.map((view) => `${view.job.id}:${view.job.state}`).join("|");
  const idle = actions.busy === null;
  useEffect(() => {
    const last = acted.current;
    if (!last || !idle) {
      return;
    }
    if (Date.now() - last.at > FOLLOW_MS) {
      acted.current = null;
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return; // Der Fokus ist nicht verloren gegangen.
    }
    const section = document.getElementById("etiketten");
    const target =
      section?.querySelector<HTMLElement>(`[data-job="${last.id}"] button`) ??
      section?.querySelector<HTMLElement>("[data-asking] button") ??
      section?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
    acted.current = null;
  }, [jobsKey, idle]);

  /** Merkt sich, an welcher Zeile gehandelt wurde, und führt die Handlung aus. */
  function act(view: JobView, run: () => Promise<void>) {
    acted.current = { id: view.job.id, at: Date.now() };
    void run();
  }

  /** Der Drucker, für den eine Meldung des Zustellversuchs gilt. */
  const printerOf = (id: string | null) => (id === null ? undefined : printing.data.printers.get(id));

  function row(view: JobView) {
    const { job } = view;
    const state = JOB_STATES[job.state];
    const busy = actions.busy === job.id;
    const waiting = job.state === "pending";
    const foreign = waiting && !view.own;
    const unassigned = waiting && !view.printer;
    return (
      <li key={job.id} className={styles.job} data-job={job.id}>
        <div className={styles.jobText}>
          <div className={styles.jobHead}>
            <span className={styles.jobTitle}>{view.title}</span>
            <Badge tone={state.tone}>{state.label}</Badge>
          </div>
          <div className={styles.muted}>
            {[view.detail, printerName(view), `${waiting ? "angefordert" : "Stand"} ${timeAgo(waiting ? job.created_at : job.updated_at, now)}`].filter((part) => part !== "").join(" · ")}
          </div>
          {job.state === "failed" && job.error ? <div className={styles.reason}>{jobErrorText(job.error)}</div> : null}
          {foreign ? (
            <div className={styles.hint}>
              Ein anderes Gerät hat dieses Etikett angefordert und druckt es, sobald es beim Drucker ist. „Hier drucken“ übernimmt es: Das andere Gerät druckt es dann nicht mehr, sobald es
              abgeglichen hat.
            </div>
          ) : null}
          {unassigned ? <div className={styles.hint}>Kein Drucker zugeordnet: Das Etikett bleibt stehen, bis es einen Standarddrucker oder einen Drucker für die Zone gibt.</div> : null}
        </div>
        <div className={styles.jobActions}>
          {unassigned ? (
            <Button size="sm" onClick={onAssign}>
              Zur Zuordnung
            </Button>
          ) : null}
          {foreign ? (
            <Button size="sm" icon={<PrinterIcon />} busy={busy} aria-label={`Hier drucken: ${view.title}`} onClick={() => act(view, () => actions.retry(view))}>
              Hier drucken
            </Button>
          ) : null}
          {job.state === "pending" || job.state === "queued" ? (
            <Button size="sm" variant="ghost" disabled={busy} aria-label={`Verwerfen: ${view.title}`} onClick={() => act(view, () => actions.cancel(view))}>
              Verwerfen
            </Button>
          ) : null}
          {job.state === "failed" || job.state === "cancelled" ? (
            <Button size="sm" icon={<RetryIcon />} busy={busy} aria-label={`Erneut drucken: ${view.title}`} onClick={() => void actions.retry(view)}>
              Erneut drucken
            </Button>
          ) : null}
          {view.hasImage ? (
            <Button size="sm" variant="ghost" icon={<ImageIcon />} aria-label={`Etikett ansehen: ${view.title}`} onClick={() => setViewing(job.id)}>
              Etikett ansehen
            </Button>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <Section
      id="etiketten"
      title="Etiketten"
      description="Alle offenen Etiketten und die der letzten 30 Tage. Gedruckt wird ein Etikett immer von dem Gerät, das es angefordert hat."
      actions={
        own > 0 ? (
          <Button variant="primary" icon={<PrinterIcon />} busy={actions.busy === "flush"} onClick={() => void flush()}>
            Jetzt drucken ({own})
          </Button>
        ) : undefined
      }
    >
      {own > 0 && ownDirect ? (
        <p className={styles.small}>Beim Drucken auf den Raspberry Pi kann der Browser einmal fragen, ob Stowly auf Geräte im lokalen Netzwerk zugreifen darf.</p>
      ) : null}

      {report ? (
        <div className={styles.report} aria-label="Ergebnis des Druckversuchs">
          <Notice tone={report.problems.length > 0 ? "neutral" : "success"} role="status" icon={report.problems.length > 0 ? undefined : <CircleCheckIcon />}>
            {flushSummary(report)}
          </Notice>
          {report.problems.map((entry) => {
            const printer = printerOf(entry.printer_id);
            return (
              <ProblemNotice
                key={entry.printer_id ?? "none"}
                problem={entry.problem}
                printer={printer}
                fallback={entry.message}
                pendingOwn={printer ? pendingFor(printing, printer) : 0}
                onHandoff={(target) => void actions.handoff(target)}
                onAssign={onAssign}
                busy={printer ? actions.busy === `handoff:${printer.id}` : false}
              />
            );
          })}
        </div>
      ) : null}

      {actions.blocked ? (
        <Notice
          tone="warn"
          role="status"
          title="Der Browser hat das neue Fenster blockiert."
          action={
            <a className={styles.external} href={actions.blocked.url} target="_blank" rel="noreferrer noopener">
              <ExternalLinkIcon size={16} aria-hidden="true" />
              Seite des Druckers öffnen
            </a>
          }
        >
          Die Etiketten sind an „{actions.blocked.printer.name}“ übergeben. Die Seite druckt sie, sobald sie geöffnet ist.
        </Notice>
      ) : null}

      {printing.jobs.length === 0 ? (
        <EmptyState icon={<LabelsIcon size={26} />} title="Noch keine Etiketten" plain>
          Beim Einlagern fordert Stowly für jede Packung eines an, solange „Etiketten“ in den Einstellungen dieses Geräts an ist.
        </EmptyState>
      ) : null}

      {printing.asking.length > 0 ? (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <h3 className={styles.groupTitle}>
              <QuestionIcon size={18} aria-hidden="true" />
              {printing.asking.length === 1 ? "Wurde das Etikett gedruckt?" : "Wurden diese Etiketten gedruckt?"}
            </h3>
            {printing.asking.length > 1 ? (
              <Button size="sm" busy={actions.busy === "all"} onClick={() => void actions.resolveAll(printing.asking)}>
                Alle gedruckt
              </Button>
            ) : null}
          </div>
          <p className={styles.muted}>Bei diesen Etiketten kennt Stowly den Ausgang nicht. Ein Blick auf den Drucker klärt es; nichts wird von selbst noch einmal gedruckt.</p>
          <ul className={cx(styles.jobs, styles.asking)} data-asking="">
            {printing.asking.map((view) => (
              <li key={view.job.id} className={styles.job}>
                <div className={styles.jobText}>
                  <div className={styles.jobHead}>
                    <span className={styles.jobTitle}>{view.title}</span>
                    <Badge tone="warn">{JOB_STATES.unknown.label}</Badge>
                  </div>
                  <div className={styles.muted}>{[view.detail, printerName(view), `Stand ${timeAgo(view.job.updated_at, now)}`].filter((part) => part !== "").join(" · ")}</div>
                  {view.job.error ? <div className={styles.reason}>{jobErrorText(view.job.error)}</div> : null}
                </div>
                <div className={styles.jobActions} role="group" aria-label={`Wurde das Etikett gedruckt? ${view.title}`}>
                  <Button size="sm" variant="primary" disabled={actions.busy !== null} aria-label={`Ja, gedruckt: ${view.title}`} onClick={() => act(view, () => actions.resolve(view, true))}>
                    Ja
                  </Button>
                  <Button size="sm" disabled={actions.busy !== null} aria-label={`Nein, nicht gedruckt: ${view.title}`} onClick={() => act(view, () => actions.resolve(view, false))}>
                    Nein
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {printing.waiting.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Ausstehend</h3>
          <ul className={styles.jobs}>{printing.waiting.map(row)}</ul>
        </div>
      ) : null}

      {done.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Verlauf</h3>
          <ul className={styles.jobs}>{done.slice(0, shown).map(row)}</ul>
          {done.length > shown ? (
            <Button variant="ghost" className={styles.more} onClick={() => setShown(shown + 4 * HISTORY_STEP)}>
              {plural(done.length - shown, "älteres Etikett", "ältere Etiketten")} zeigen
            </Button>
          ) : null}
        </div>
      ) : null}

      {viewed ? <ImageDialog view={viewed} onClose={() => setViewing(null)} /> : null}
    </Section>
  );
}
