import { useEffect, useRef, useState } from "react";

import { useCore, type Printer, type PrintFlushReport } from "@/contract";
import { EmptyState, Notice, plural, Section, timeAgo } from "@/ui";
import { Badge, Button, cx, Dialog } from "@/ui/base";
import { CircleCheckIcon, ExternalLinkIcon, ImageIcon, LabelsIcon, PrinterIcon, QuestionIcon, RetryIcon } from "@/ui/icons";

import type { LabelActions } from "./labelActions";
import { LabelImage } from "./LabelImage";
import { flushSummary, JOB_STATES, jobErrorText, type JobGroup, type JobView } from "./model";
import { ProblemNotice } from "./PrinterCard";
import styles from "./PrintersPage.module.css";
import type { Printing } from "./usePrinting";

/** So viele erledigte Etiketten zeigt der Verlauf zunächst; mehr auf Wunsch. */
const HISTORY_STEP = 12;
/** So lange nach einem Klick an einer Zeile zieht der Fokus mit, wenn die Zeile ihren Platz wechselt. */
const FOLLOW_MS = 5000;

/** Die Handlungen an einer Zeile, nach ihrer Schaltfläche: „Hier drucken", „Verwerfen", „Ja", „Nein". */
type RowAction = "retry" | "cancel" | "yes" | "no";

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

  // Während des Versuchs behält „Jetzt drucken" den Fokus. Steht danach nichts mehr aus, ist die
  // Schaltfläche weg und mit ihr der Fokus: Er geht dann an das Ergebnis, das der Versuch gebracht hat.
  const reportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (report !== null && (active === null || active === document.body)) {
      reportRef.current?.focus({ preventScroll: true });
    }
  }, [report]);

  // Eine Antwort, ein Verwerfen oder „Hier drucken" räumt die Zeile weg und mit ihr die
  // Schaltfläche, die den Fokus hatte. Damit er nicht verloren geht:
  // - nach einem Nein zur selben Packung an ihrem neuen Platz: Dort steht „Erneut drucken";
  // - sonst zur Zeile, die jetzt an dieser Stelle der Gruppe steht (oder der davor), und zwar
  //   an die Zeile selbst, nicht an eine ihrer Schaltflächen: Ein zweites Enter löst so nichts aus;
  // - ist die Gruppe leer, zur nächsten Nachfrage oder zur ersten Schaltfläche des Abschnitts.
  const acted = useRef<{ id: string; group: JobGroup; index: number; follow: boolean; at: number } | null>(null);
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
    const rows = Array.from(section?.querySelectorAll<HTMLElement>(`[data-group="${last.group}"] > li`) ?? []);
    const target =
      (last.follow ? section?.querySelector<HTMLElement>(`[data-job="${last.id}"] button`) : null) ??
      rows[Math.min(last.index, rows.length - 1)] ??
      section?.querySelector<HTMLElement>('[data-group="ask"] > li') ??
      section?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
    acted.current = null;
  }, [jobsKey, idle]);

  /** Die zuletzt gedrückte Schaltfläche einer Zeile, "<Aktion>:<Etikett>". */
  const [pressed, setPressed] = useState<string | null>(null);
  /** Ob die Schaltfläche `action` an diesem Etikett gerade arbeitet: Sie zeigt dann den Spinner, die anderen der Zeile sind gesperrt. */
  const running = (action: RowAction, id: string) => actions.busy === id && pressed === `${action}:${id}`;

  /**
   * Merkt sich, an welcher Zeile und mit welcher Schaltfläche gehandelt wurde, und führt die Handlung aus.
   * @param follow danach der Zeile an ihren neuen Platz folgen (nach einem Nein)
   */
  function act(view: JobView, action: RowAction, run: () => Promise<void>, follow = false) {
    const list = view.group === "ask" ? printing.asking : view.group === "waiting" ? printing.waiting : done;
    acted.current = { id: view.job.id, group: view.group, index: Math.max(0, list.indexOf(view)), follow, at: Date.now() };
    setPressed(`${action}:${view.job.id}`);
    void run();
  }

  /** Der Drucker, für den eine Meldung des Zustellversuchs gilt. */
  const printerOf = (id: string | null) => (id === null ? undefined : printing.data.printers.get(id));

  // Der Verweis auf die Seite des Druckdienstes gilt, solange eines der übergebenen Etiketten noch
  // offen ist. Danach verschwindet er: Die Seite druckte sie nach einem Neustart des Pi ein zweites Mal.
  const handed = actions.blocked;
  const blocked =
    handed !== null && printing.jobs.some((view) => handed.jobIds.includes(view.job.id) && view.job.state === "unknown" && view.job.error === "handoff") ? handed : null;

  function row(view: JobView) {
    const { job } = view;
    const state = JOB_STATES[job.state];
    const busy = actions.busy === job.id;
    const waiting = job.state === "pending";
    const foreign = waiting && !view.own;
    const unassigned = waiting && !view.printer;
    return (
      // tabIndex -1: Verschwindet die Nachbarzeile, kann der Fokus hierher wechseln (siehe oben).
      <li key={job.id} className={styles.job} data-job={job.id} tabIndex={-1}>
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
            <Button
              size="sm"
              icon={<PrinterIcon />}
              busy={running("retry", job.id)}
              disabled={busy}
              aria-label={`Hier drucken: ${view.label}`}
              onClick={() => act(view, "retry", () => actions.retry(view))}
            >
              Hier drucken
            </Button>
          ) : null}
          {job.state === "pending" || job.state === "queued" ? (
            <Button
              size="sm"
              variant="ghost"
              busy={running("cancel", job.id)}
              disabled={busy}
              aria-label={`Verwerfen: ${view.label}`}
              onClick={() => act(view, "cancel", () => actions.cancel(view))}
            >
              Verwerfen
            </Button>
          ) : null}
          {job.state === "failed" || job.state === "cancelled" ? (
            <Button size="sm" icon={<RetryIcon />} busy={busy} aria-label={`Erneut drucken: ${view.label}`} onClick={() => void actions.retry(view)}>
              Erneut drucken
            </Button>
          ) : null}
          {view.hasImage ? (
            <Button size="sm" variant="ghost" icon={<ImageIcon />} aria-label={`Etikett ansehen: ${view.label}`} onClick={() => setViewing(job.id)}>
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
        <div ref={reportRef} className={styles.report} role="group" aria-label="Ergebnis des Druckversuchs" tabIndex={-1}>
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
                // Ein Etikett, das schon an einen inzwischen gelöschten Drucker abgeschickt war, bleibt bei ihm.
                name={entry.printer_id !== null && printer === undefined ? "Gelöschter Drucker" : undefined}
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

      {blocked ? (
        <Notice
          tone="warn"
          role="status"
          title="Der Browser hat das neue Fenster blockiert."
          action={
            <a className={styles.external} href={blocked.url} target="_blank" rel="noreferrer noopener">
              <ExternalLinkIcon size={16} aria-hidden="true" />
              Seite des Druckers öffnen
            </a>
          }
        >
          Die Etiketten sind an „{blocked.printer.name}“ übergeben. Die Seite des Druckers druckt sie nach einem Tipp auf „Drucken“.
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
          <ul className={cx(styles.jobs, styles.asking)} data-group="ask">
            {printing.asking.map((view) => (
              <li key={view.job.id} className={styles.job} data-job={view.job.id} tabIndex={-1}>
                <div className={styles.jobText}>
                  <div className={styles.jobHead}>
                    <span className={styles.jobTitle}>{view.title}</span>
                    <Badge tone="warn">{JOB_STATES.unknown.label}</Badge>
                  </div>
                  <div className={styles.muted}>{[view.detail, printerName(view), `Stand ${timeAgo(view.job.updated_at, now)}`].filter((part) => part !== "").join(" · ")}</div>
                  {view.job.error ? <div className={styles.reason}>{jobErrorText(view.job.error)}</div> : null}
                </div>
                <div className={styles.jobActions} role="group" aria-label={`Wurde das Etikett gedruckt? ${view.label}`}>
                  <Button
                    size="sm"
                    variant="primary"
                    busy={running("yes", view.job.id)}
                    disabled={actions.busy !== null}
                    aria-label={`Ja, gedruckt: ${view.label}`}
                    onClick={() => act(view, "yes", () => actions.resolve(view, true))}
                  >
                    Ja
                  </Button>
                  <Button
                    size="sm"
                    busy={running("no", view.job.id)}
                    disabled={actions.busy !== null}
                    aria-label={`Nein, nicht gedruckt: ${view.label}`}
                    onClick={() => act(view, "no", () => actions.resolve(view, false), true)}
                  >
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
          <ul className={styles.jobs} data-group="waiting">
            {printing.waiting.map(row)}
          </ul>
        </div>
      ) : null}

      {done.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Verlauf</h3>
          <ul className={styles.jobs} data-group="done">
            {done.slice(0, shown).map(row)}
          </ul>
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
