import { formatTimestamp, type Printer, type PrinterProbe, type Zone } from "@/contract";
import { Notice, timeAgo, ZoneLabel } from "@/ui";
import { Badge, Button, cx, type BadgeTone } from "@/ui/base";
import { CircleCheckIcon, CpuIcon, ExternalLinkIcon, ImageIcon, PlugIcon, ServerIcon, WarningIcon } from "@/ui/icons";

import { handoffHelps, problemText, type DeliveryProblem, type Fact, type HealthLevel, type PrinterHealth } from "./model";
import styles from "./PrintersPage.module.css";

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
export function ProblemNotice({ problem, printer, fallback, pendingOwn, onHandoff, onAssign, busy = false }: ProblemNoticeProps) {
  const text = problemText(problem, printer, window.location.origin, fallback);
  const handoff = printer?.connection === "direct" && handoffHelps(problem) && pendingOwn > 0 && onHandoff !== undefined;
  return (
    <Notice
      tone="warn"
      role="status"
      icon={<WarningIcon />}
      title={printer ? `${printer.name}: ${text.title}` : text.title}
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

/** Stand einer Abfrage: läuft noch, oder das Ergebnis. */
export type ProbeState = { status: "busy" } | { status: "done"; probe: PrinterProbe } | { status: "failed"; message: string };

export interface PrinterCardProps {
  printer: Printer;
  health: PrinterHealth;
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
}

/** Ein Drucker mit dem, wofür er zuständig ist, und dem, was zuletzt von ihm gesehen wurde. */
export function PrinterCard({ printer, health, now, isDefault, zones, multiZone, probe, fresh, pendingOwn, handoffBusy, onProbe, onEdit, onDelete, onHandoff }: PrinterCardProps) {
  const direct = printer.connection === "direct";
  const image = printer.server?.driver === "image";
  const kind = direct ? "direkt (Raspberry Pi)" : image ? "am Server · Bild (PNG)" : `am Server · ${printer.server?.model ?? "Brother QL"}`;
  const where = direct ? (printer.direct?.urls ?? []).join(" · ") : (printer.server?.address ?? "");
  const done = probe?.status === "done" ? probe.probe : undefined;

  return (
    <li className={styles.printer} aria-label={printer.name}>
      <div className={styles.printerHead}>
        <span className={styles.printerIcon} aria-hidden="true">
          {direct ? <CpuIcon size={22} /> : image ? <ImageIcon size={22} /> : <ServerIcon size={22} />}
        </span>
        <div className={styles.printerTitle}>
          <h3 className={styles.printerName}>{printer.name}</h3>
          <div className={styles.muted}>{kind}</div>
          {where !== "" ? <div className={cx(styles.muted, styles.address)}>{where}</div> : null}
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
          {health.errors.length > 0 ? (
            <ul className={styles.errors}>
              {health.errors.map((error) => (
                <li key={error}>
                  <WarningIcon size={15} aria-hidden="true" />
                  <span>{error}</span>
                </li>
              ))}
            </ul>
          ) : null}
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
      {done && done.problem === null ? (
        <Notice tone="success" role="status" icon={<CircleCheckIcon />} title="Der Druckdienst antwortet.">
          {done.url ? `Erreicht über ${done.url}. ` : ""}
          {done.health ? `Druckdienst ${done.health.version}.` : ""}
        </Notice>
      ) : null}
      {done && done.problem !== null ? (
        <ProblemNotice problem={done.problem} printer={printer} fallback={done.error} pendingOwn={pendingOwn} onHandoff={onHandoff} busy={handoffBusy} />
      ) : null}
      {probe?.status === "failed" ? (
        <Notice tone="danger" role="alert">
          {probe.message}
        </Notice>
      ) : null}

      <div className={styles.printerActions}>
        <Button size="sm" variant={fresh && !probe ? "primary" : "secondary"} icon={<PlugIcon />} busy={probe?.status === "busy"} aria-label={`Verbindung prüfen: ${printer.name}`} onClick={onProbe}>
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
