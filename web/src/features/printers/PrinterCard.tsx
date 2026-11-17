import { formatTimestamp, type PairedPrinter, type Printer, type PrinterProbe, type PrinterStatus, type Zone } from "@/contract";
import { Notice, timeAgo, ZoneLabel } from "@/ui";
import { Badge, Button, cx, type BadgeTone } from "@/ui/base";
import { CircleCheckIcon, CpuIcon, ExternalLinkIcon, ImageIcon, PlugIcon, RefreshIcon, ServerIcon, WarningIcon } from "@/ui/icons";

import { handoffHelps, problemText, type DeliveryProblem, type Fact, type HealthLevel, type PrinterHealth } from "./model";
import { rememberedPapers, type HouseholdPaper } from "./paper";
import styles from "./PrintersPage.module.css";
import { outdatedService, probeVerdict, seenAdvice, type PrinterAdvice } from "./verdict";

const LEVEL_TONES: Record<HealthLevel, BadgeTone> = { never: "neutral", ok: "success", attention: "warn", trouble: "danger" };

function Facts({ facts, label }: { facts: readonly Fact[]; label: string }) {
  return (
    <dl className={styles.facts} aria-label={label}>
      {facts.map((fact) => (
        <div key={fact.key} className={cx(styles.fact, styles[`fact-${fact.tone}`])}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ProblemNoticeProps {
  problem: DeliveryProblem;
  /** Der betroffene Drucker; undefined bei Etiketten ohne Drucker. */
  printer: Printer | undefined;
  /** Name für die Überschrift, wenn der Drucker nicht mehr in der Liste steht (gelöscht). */
  name?: string;
  /** Rückfall, falls die App den Grund nicht kennt. */
  fallback?: string | null;
  /** Eigene ausstehende Etiketten für diesen Drucker: Dann lohnt der Notweg. */
  pendingOwn: number;
  onHandoff?: (printer: Printer) => void;
  /** Weg zur Zuordnung, wenn dem Etikett kein Drucker zugeordnet ist. */
  onAssign?: () => void;
  busy?: boolean;
}

/** Warum ein Druckdienst gerade nicht benutzbar ist, mit dem nächsten Schritt und, wo er hilft, dem Notweg. */
export function ProblemNotice({ problem, printer, name, fallback, pendingOwn, onHandoff, onAssign, busy = false }: ProblemNoticeProps) {
  const text = problemText(problem, printer, window.location.origin, fallback);
  const handoff = printer?.connection === "direct" && handoffHelps(problem) && pendingOwn > 0 && onHandoff !== undefined;
  const label = printer?.name ?? name;
  return (
    <Notice
      tone="warn"
      role="status"
      icon={<WarningIcon />}
      title={label ? `${label}: ${text.title}` : text.title}
      action={
        handoff ? (
          <Button size="sm" icon={<ExternalLinkIcon />} busy={busy} onClick={() => onHandoff(printer)}>
            Über die Seite des Druckers drucken
          </Button>
        ) : problem === "no_printer" && onAssign ? (
          <Button size="sm" onClick={onAssign}>
            Zur Zuordnung
          </Button>
        ) : undefined
      }
    >
      <p>{text.advice}</p>
      {handoff ? (
        <p className={styles.small}>
          Der Notweg öffnet eine Seite des Pi in einem neuen Tab; sie druckt {pendingOwn === 1 ? "das ausstehende Etikett" : "die ausstehenden Etiketten"} selbst. Stowly erfährt das Ergebnis
          nicht und fragt danach, ob gedruckt wurde.
        </p>
      ) : null}
    </Notice>
  );
}

/** Ein Hinweis mit Rat als Liste: Was los ist, was zu tun ist. */
function AdviceList({ advice }: { advice: readonly string[] }) {
  return (
    <ul className={styles.advice}>
      {advice.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ul>
  );
}

/** Der Druckdienst ist zu alt für das Papier des Haushalts; neu koppeln spielt den neuen ein. */
export function OutdatedNotice({ version, onRepair }: { version: string | null; onRepair?: () => void }) {
  return (
    <Notice
      tone="warn"
      role="status"
      icon={<WarningIcon />}
      title={`Druckdienst ${version ?? "auf dem Pi"} kann dieses Papier nicht.`}
      action={
        onRepair ? (
          <Button size="sm" icon={<RefreshIcon />} onClick={onRepair}>
            Neu koppeln
          </Button>
        ) : undefined
      }
    >
      Seine Etiketten bleiben ausstehend, bis der Pi neu gekoppelt ist; falsch gedruckt wird nichts. Neu koppeln spielt den neuen Druckdienst ein, Token und Zuordnung bleiben.
    </Notice>
  );
}

/** Der Zustand des Druckers mit Rat, gelb. */
function AdviceNotice({ advice, roll }: { advice: PrinterAdvice; roll?: string | null }) {
  return (
    <Notice tone="warn" role="status" icon={<WarningIcon />} title={advice.title}>
      <AdviceList advice={advice.advice} />
      {roll ? <p className={styles.small}>Rolle: {roll}</p> : null}
    </Notice>
  );
}

export interface ProbeResultProps {
  probe: PrinterProbe;
  printer: Printer;
  /** Das Papier des Haushalts laut Vorlagen; null, solange es nicht gelesen ist. */
  paper: HouseholdPaper | null;
  /** Eigene ausstehende Etiketten für diesen Drucker: Dann lohnt der Notweg. */
  pendingOwn: number;
  onHandoff?: (printer: Printer) => void;
  handoffBusy?: boolean;
  /** Neu koppeln, wenn der Druckdienst zu alt ist; ohne Angabe keine Schaltfläche. */
  onRepair?: () => void;
}

/**
 * Das Ergebnis von „Verbindung prüfen" aus Dienst und Drucker (`probeVerdict`): grün nur, wenn
 * beide bereit sind; gelb mit Rat, wenn der Dienst antwortet und der Drucker nicht; sonst der Grund,
 * warum der Dienst nicht benutzbar ist. Auch für das Koppeln eines Pi (Dialog und Assistent).
 */
export function ProbeResult({ probe, printer, paper, pendingOwn, onHandoff, handoffBusy = false, onRepair }: ProbeResultProps) {
  const verdict = probeVerdict(probe, printer, paper?.name ?? null, rememberedPapers());
  switch (verdict.kind) {
    case "service":
      return <ProblemNotice problem={verdict.problem} printer={printer} fallback={probe.error} pendingOwn={pendingOwn} onHandoff={onHandoff} busy={handoffBusy} />;
    case "outdated":
      return <OutdatedNotice version={verdict.version} onRepair={onRepair} />;
    case "printer":
      return <AdviceNotice advice={verdict.advice} roll={verdict.roll} />;
    case "ready":
      return (
        <Notice tone="success" role="status" icon={<CircleCheckIcon />} title="Drucker bereit.">
          {verdict.roll ? <p>Rolle: {verdict.roll}</p> : null}
          <p>
            {probe.url ? `Erreicht über ${probe.url}. ` : ""}
            {probe.health ? `Druckdienst ${probe.health.version}.` : ""}
          </p>
        </Notice>
      );
  }
}

/** Stand einer Abfrage: läuft noch, oder das Ergebnis. */
export type ProbeState = { status: "busy" } | { status: "done"; probe: PrinterProbe } | { status: "failed"; message: string };

export interface PrinterCardProps {
  printer: Printer;
  health: PrinterHealth;
  /** Was zuletzt von ihm gesehen wurde (`data.printerStatus`), für den Rat unter „Zuletzt gesehen". */
  seen?: PrinterStatus;
  /** Das Papier des Haushalts laut Vorlagen; null, solange es nicht gelesen ist. */
  paper?: HouseholdPaper | null;
  /** Die Kopplung eines Pi, wie der Server sie kennt (Version des Druckdienstes); undefined = keine bekannt. */
  paired?: PairedPrinter;
  /** Jetzt, in Millisekunden (`useNow`). */
  now: number;
  isDefault: boolean;
  /** Zonen, die ausdrücklich diesen Drucker nutzen. */
  zones: readonly Zone[];
  /** Zonen überhaupt zeigen (mehr als eine Zone). */
  multiZone: boolean;
  probe: ProbeState | undefined;
  /** Eben angelegt: Die Karte bietet an, die Verbindung zu prüfen. */
  fresh: boolean;
  /** Eigene ausstehende Etiketten für diesen Drucker. */
  pendingOwn: number;
  handoffBusy: boolean;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onHandoff: (printer: Printer) => void;
  /** Neu koppeln (nur ein Pi): spielt einen neuen Druckdienst ein. */
  onRepair?: () => void;
}

/** Ein Drucker mit dem, wofür er zuständig ist, und dem, was zuletzt von ihm gesehen wurde. */
export function PrinterCard({
  printer,
  health,
  seen,
  paper = null,
  paired,
  now,
  isDefault,
  zones,
  multiZone,
  probe,
  fresh,
  pendingOwn,
  handoffBusy,
  onProbe,
  onEdit,
  onDelete,
  onHandoff,
  onRepair,
}: PrinterCardProps) {
  const direct = printer.connection === "direct";
  const image = printer.server?.driver === "image";
  const kind = direct ? "direkt (Raspberry Pi)" : image ? "am Server · Bild (PNG)" : `am Server · ${printer.server?.model ?? "Brother QL"}`;
  // Je Adresse eine Zeile: So bricht am Handy keine Adresse mitten im Port um.
  const where = direct ? (printer.direct?.urls ?? []) : printer.server?.address ? [printer.server.address] : [];
  const done = probe?.status === "done" ? probe.probe : undefined;
  // Ohne neues Prüfen: der Rat zum zuletzt gesehenen Zustand. Nach dem Prüfen gilt dessen Urteil.
  const seenHint = done ? null : seenAdvice(seen, printer, paper?.name ?? null);
  // Ein Druckdienst vor 0.5.0 kann kein Papier im Format 2; der Server ist immer aktuell.
  const outdated = direct && paper && done?.problem !== "outdated" ? outdatedService(paper.schema, done, paired) : null;

  return (
    <li className={styles.printer} aria-label={printer.name} data-printer={printer.id}>
      <div className={styles.printerHead}>
        <span className={styles.printerIcon} aria-hidden="true">
          {direct ? <CpuIcon size={22} /> : image ? <ImageIcon size={22} /> : <ServerIcon size={22} />}
        </span>
        <div className={styles.printerTitle}>
          <h3 className={styles.printerName}>{printer.name}</h3>
          <div className={styles.muted}>{kind}</div>
          {where.map((address) => (
            <div key={address} className={cx(styles.muted, styles.address)}>
              {address}
            </div>
          ))}
        </div>
        <Badge tone={LEVEL_TONES[health.level]} className={styles.level}>
          {health.summary}
        </Badge>
      </div>

      <div className={styles.duties}>
        <span className={styles.dutiesLabel}>Druckt für</span>
        {isDefault ? <Badge tone="accent">Standarddrucker</Badge> : null}
        {multiZone ? zones.map((zone) => <ZoneLabel key={zone.id} zone={zone} className={styles.dutyZone} />) : null}
        {!isDefault && (!multiZone || zones.length === 0) ? <span className={styles.muted}>noch nichts: weder Standarddrucker noch einer Zone zugeordnet</span> : null}
      </div>

      {health.observedAt === null ? (
        <p className={styles.muted}>
          Noch nie gesehen. {direct ? "Sein Zustand erscheint, sobald ein Gerät im WLAN des Pi die Verbindung geprüft oder gedruckt hat." : "Sein Zustand erscheint nach der ersten Abfrage."}
        </p>
      ) : (
        <>
          <p className={styles.seen}>
            <span>
              Zuletzt gesehen {timeAgo(health.observedAt, now)} <span className={styles.muted}>({formatTimestamp(health.observedAt)})</span>
            </span>
            {health.stale ? <Badge>Stand ist alt</Badge> : null}
          </p>
          <Facts facts={health.facts} label="Zustand des Druckers" />
          {seenHint ? <AdviceNotice advice={seenHint} /> : null}
          {health.host.length > 0 ? (
            <div className={styles.host}>
              <div className={styles.hostTitle}>Rechner (Raspberry Pi)</div>
              <Facts facts={health.host} label="Zustand des Rechners" />
            </div>
          ) : null}
        </>
      )}

      {fresh && !probe ? (
        <Notice tone="accent" icon={<PlugIcon />} title="Drucker angelegt">
          Als Nächstes die Verbindung prüfen: So zeigt sich gleich, ob die Angaben stimmen.
        </Notice>
      ) : null}
      {outdated ? <OutdatedNotice version={outdated.version} onRepair={onRepair} /> : null}
      {done ? <ProbeResult probe={done} printer={printer} paper={paper} pendingOwn={pendingOwn} onHandoff={onHandoff} handoffBusy={handoffBusy} onRepair={onRepair} /> : null}
      {probe?.status === "failed" ? (
        <Notice tone="danger" role="alert">
          {probe.message}
        </Notice>
      ) : null}

      <div className={styles.printerActions}>
        <Button
          size="sm"
          variant={fresh && !probe ? "primary" : "secondary"}
          icon={<PlugIcon />}
          busy={probe?.status === "busy"}
          aria-label={`Verbindung prüfen: ${printer.name}`}
          data-probe=""
          onClick={onProbe}
        >
          Verbindung prüfen
        </Button>
        <Button size="sm" aria-label={`Bearbeiten: ${printer.name}`} onClick={onEdit}>
          Bearbeiten
        </Button>
        <Button size="sm" variant="danger" aria-label={`Löschen: ${printer.name}`} onClick={onDelete}>
          Löschen
        </Button>
      </div>
      {direct ? (
        <p className={styles.small}>Beim Prüfen und beim Drucken kann der Browser einmal fragen, ob Stowly auf Geräte im lokalen Netzwerk zugreifen darf. Ohne diese Erlaubnis erreicht die App den Pi nicht.</p>
      ) : null}
    </li>
  );
}
