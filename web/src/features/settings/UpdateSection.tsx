import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { formatDate, formatTimestamp, isCoreError, toLocalDate, UPDATE_CHECK_INTERVAL_S, UPDATE_CHECK_MIN_GAP_S, useCore, type CoreError, type UpdateStatus } from "@/contract";
import { ConfirmDialog, errorText, List, ListRow, Notice, Section, timeAgo, useNow, type NoticeTone } from "@/ui";
import { Badge, Button, Spinner, useToast, type ToastTone } from "@/ui/base";
import { ChevronDownIcon, ChevronUpIcon, CircleCheckIcon, CloudOffIcon, DownloadIcon, ExternalLinkIcon, HourglassIcon, InfoIcon, RefreshIcon, WarningIcon } from "@/ui/icons";

import { durationText, everyText } from "./HomeAssistantSection";
import type { IntegrationsState } from "./integrations";
import { useSecondsLeft } from "./PushSetting";
import styles from "./SettingsPage.module.css";

/** So oft lädt der Abschnitt den Zustand neu, solange ein Update angefordert ist oder läuft. */
export const UPDATE_POLL_MS = 10_000;

/** Was die Rückfrage vor dem Anfordern sagt. */
export const INSTALL_WARNING =
  "Stowly ist etwa ein bis zwei Minuten nicht erreichbar. Vorher sichert der Rechner die Datenbank; startet die neue Version nicht, kehrt er zur alten zurück.";

const NOT_CONFIGURED = "Updates sind auf diesem Server nicht eingerichtet (STOWLY_UPDATE_REPO).";
const NO_UPDATER = "Der Updater auf dem Rechner meldet sich nicht. Anleitung: docs/betrieb.md, Abschnitt 9.";

/** Wie oft der Server von selbst bei GitHub fragt (`UPDATE_CHECK_INTERVAL_S`): „alle 6 Stunden". */
export function checkIntervalText(seconds: number = UPDATE_CHECK_INTERVAL_S): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "jede Stunde" : `alle ${String(hours)} Stunden`;
  }
  return everyText(seconds);
}

/** Wie oft „Nach Updates suchen" geht (`UPDATE_CHECK_MIN_GAP_S`): „einmal je Minute". */
function checkGapText(seconds: number = UPDATE_CHECK_MIN_GAP_S): string {
  return seconds === 60 ? "einmal je Minute" : `einmal in ${durationText(seconds)}`;
}

/** Der Kalendertag eines Zeitpunkts in der Zeitzone des Geräts: „12.11.2026". */
function dayOf(timestamp: string): string {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? timestamp : formatDate(toLocalDate(new Date(ms)));
}

/** Nur eine Seite auf GitHub wird verlinkt; der Server lässt ohnehin nichts anderes durch (10.2). */
function githubPage(url: string | null): string | null {
  return url !== null && url.startsWith("https://github.com/") ? url : null;
}

function sentences(...parts: string[]): string {
  return parts.filter((part) => part !== "").join(" ");
}

/** Eine Überschrift als Satz für die Ansage: mit Punkt, außer sie endet schon mit einem Zeichen dafür. */
function asSentence(title: string): string {
  return title === "" || /[.…!?]$/.test(title) ? title : `${title}.`;
}

/** Was die Zeile „Neueste Version" rechts zeigt und darunter erklärt. */
export function describeLatest(update: UpdateStatus): { value: string; hint: string } {
  if (update.latest === null) {
    // Eine gelungene Abfrage ohne Release (404) setzt `checked_at`, eine gescheiterte nicht.
    return update.checked_at !== null
      ? { value: "noch keine Version veröffentlicht", hint: `${update.repo ? `Im Repository ${update.repo}` : "Auf GitHub"} gibt es noch kein Release.` }
      : { value: "noch nicht gefragt", hint: `Der Server fragt GitHub kurz nach seinem Start und danach ${checkIntervalText()}.` };
  }
  const about = [update.latest_name ? `„${update.latest_name}“` : "", update.published_at ? `erschienen am ${dayOf(update.published_at)}` : ""]
    .filter((part) => part !== "")
    .join(", ");
  const verdict = update.available ? `Neuer als die installierte Version ${update.current}.` : "Stowly ist auf dem neuesten Stand.";
  return { value: update.latest, hint: about === "" ? verdict : `${about}. ${verdict}` };
}

/** Ein Hinweis zum Stand eines Updates. */
export interface UpdateNotice {
  tone: NoticeTone;
  /** Leer, wenn der Hinweis nur aus dem Text besteht. */
  title: string;
  text: string;
}

/**
 * Der Hinweis zum Stand eines Updates (`UpdateStatus.state`, docs/integrationen.md 10.4); null,
 * wenn es nichts zu sagen gibt. Ohne relative Zeiten: Der Satz wird angesagt, sobald er sich ändert.
 * Einen Stand, den diese App noch nicht kennt (ein neuerer Server), übergeht er bis auf den Satz.
 */
export function describeUpdateState(update: UpdateStatus): UpdateNotice | null {
  const version = update.state_version ?? update.latest ?? "";
  const extra = update.state_message ?? "";
  switch (update.state) {
    case "requested":
      return { tone: extra === "" ? "info" : "warn", title: "Angefordert", text: sentences("Der Updater übernimmt in den nächsten Minuten.", extra) };
    case "installing":
      return {
        tone: extra === "" ? "info" : "warn",
        title: "Wird installiert …",
        text: sentences(`Der Updater holt Stowly ${version} und startet Stowly neu; dabei ist es kurz nicht erreichbar.`, extra),
      };
    case "done":
      return { tone: "success", title: `Aktualisiert auf ${version}`, text: sentences(update.state_at ? `Am ${formatTimestamp(update.state_at)}.` : "", extra) };
    case "failed":
      return { tone: "danger", title: `Update auf ${version} gescheitert`, text: extra !== "" ? extra : "Die bisherige Version läuft weiter." };
    default:
      return extra !== "" ? { tone: "neutral", title: "", text: extra } : null;
  }
}

/** Was nach „Nach Updates suchen" kurz gemeldet wird. */
export function checkResult(update: UpdateStatus): { message: string; tone: ToastTone } {
  if (update.check_error !== null) {
    return { tone: "warn", message: `Die Suche ist gescheitert: ${update.check_error}` };
  }
  if (update.latest === null) {
    return { tone: "neutral", message: "Auf GitHub ist noch keine Version veröffentlicht." };
  }
  return update.available ? { tone: "success", message: `Neue Version gefunden: Stowly ${update.latest}` } : { tone: "success", message: "Stowly ist auf dem neuesten Stand." };
}

/**
 * Der Satz des Servers zu "not_configured": Nur er weiß, was fehlt (STOWLY_UPDATE_REPO, der
 * Updater, die Abfrage bei GitHub). Ohne Satz gilt `fallback`.
 */
function notConfiguredText(caught: CoreError, fallback: string): string {
  return caught.message.trim() !== "" && caught.message !== caught.code ? caught.message : fallback;
}

/** Warum das Anfordern scheiterte. Was am Stand des Servers nicht passt, sagt er selbst genau (10.5). */
export function installErrorText(caught: unknown): string {
  if (isCoreError(caught, "not_configured")) {
    return notConfiguredText(caught, "Updates sind auf dem Rechner nicht vollständig eingerichtet (docs/betrieb.md, Abschnitt 9).");
  }
  return errorText(caught, { offline: "Zum Anfordern braucht es den Server, und der ist gerade nicht erreichbar." });
}

function stateIcon(update: UpdateStatus): ReactNode {
  switch (update.state) {
    case "requested":
      return <HourglassIcon />;
    case "installing":
      return <Spinner />;
    case "done":
      return <CircleCheckIcon />;
    case "failed":
      return <WarningIcon />;
    default:
      return <InfoIcon />;
  }
}

/** Eine Meldung unter der Liste, nach „Nach Updates suchen". */
interface CheckMessage {
  tone: NoticeTone;
  title: string;
  text: string;
}

/**
 * „Aktualisierung": welche Version läuft, welche auf GitHub die neueste ist, und das Update auf
 * Knopfdruck (docs/integrationen.md, Abschnitt 10). Den Zustand meldet der Server mit den übrigen
 * Integrationen (`core.integrations.load`); installiert wird vom Updater auf dem Rechner, nach einer
 * Rückfrage. Solange ein Update angefordert ist oder läuft, lädt der Abschnitt den Zustand alle
 * `UPDATE_POLL_MS` neu, aber nur, solange er zu sehen ist. Antwortet der Server dabei nicht,
 * startet er gerade neu. Wechsel des Stands sagt eine Statuszeile für Screenreader an.
 */
export function UpdateSection({ integrations, onReload }: { integrations: IntegrationsState; onReload: () => void }) {
  const core = useCore();
  const toast = useToast();
  const now = useNow();
  const notesId = useId();
  /** Der zuletzt bekannte Zustand: vom Server geladen oder die Antwort der letzten Aktion. Er bleibt, solange der Server fehlt. */
  const [known, setKnown] = useState<UpdateStatus | null>(integrations.status === "ready" ? integrations.value.update : null);
  const [seen, setSeen] = useState(integrations);
  if (seen !== integrations) {
    // Neu geladen: Jetzt weiß es der Server am besten.
    setSeen(integrations);
    if (integrations.status === "ready") {
      setKnown(integrations.value.update);
    }
  }
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<CheckMessage | null>(null);
  const [pauseUntil, setPauseUntil] = useState(0);
  const secondsLeft = useSecondsLeft(pauseUntil);
  const [confirming, setConfirming] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const stateRef = useRef<HTMLDivElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  const inFlight = known !== null && (known.state === "requested" || known.state === "installing");
  // Ein Update läuft, und der Server antwortet nicht: Er startet neu. Auch während des nächsten
  // Versuchs (der Zustand lädt gerade), damit der Hinweis nicht mit jedem Nachfragen flackert.
  const restarting = inFlight && (integrations.status === "loading" || (integrations.status === "error" && integrations.offline));

  // Solange ein Update angefordert ist oder läuft, alle 10 Sekunden nachfragen; nur, solange der
  // Abschnitt da ist und die Seite zu sehen.
  useEffect(() => {
    if (!inFlight) {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") {
        onReload();
      }
    }, UPDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, onReload]);

  // Nach der Rückfrage: Fiel der Fokus ins Leere, weil es „Update installieren" nicht mehr gibt,
  // geht er an den Stand des Updates (sonst an „Nach Updates suchen").
  useEffect(() => {
    if (wasConfirming.current && !confirming) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        (stateRef.current ?? checkRef.current)?.focus();
      }
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  async function check() {
    setChecking(true);
    setMessage(null);
    try {
      const result = await core.update.check();
      setKnown(result);
      toast.show({ id: "update-check", ...checkResult(result) });
    } catch (caught) {
      if (isCoreError(caught, "rate_limited")) {
        const wait = typeof caught.details.retry_after_s === "number" && caught.details.retry_after_s > 0 ? caught.details.retry_after_s : UPDATE_CHECK_MIN_GAP_S;
        setPauseUntil(Date.now() + wait * 1000);
        setMessage({ tone: "info", title: "Gerade erst gesucht", text: `Nach Updates suchen geht höchstens ${checkGapText()}. Bitte kurz warten.` });
      } else {
        setMessage({
          tone: isCoreError(caught, "offline") || isCoreError(caught, "not_configured") ? "warn" : "danger",
          title: "Keine Suche möglich",
          text: isCoreError(caught, "not_configured")
            ? notConfiguredText(caught, NOT_CONFIGURED)
            : errorText(caught, { offline: "Gesucht wird über den Server, und der ist gerade nicht erreichbar." }),
        });
      }
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    const version = known?.latest ?? null;
    if (version === null) {
      setConfirming(false);
      return;
    }
    try {
      const result = await core.update.install(version);
      setKnown(result);
      setMessage(null);
      setConfirming(false);
    } catch (caught) {
      // Der Stand des Servers ist ein anderer als hier gezeigt: neu laden; die Rückfrage nennt den Grund.
      if (isCoreError(caught, "conflict") || isCoreError(caught, "not_configured")) {
        onReload();
      }
      throw caught;
    }
  }

  const stateNotice = known !== null && !restarting ? describeUpdateState(known) : null;
  const announcement = restarting ? "Server startet neu …" : stateNotice ? sentences(asSentence(stateNotice.title), stateNotice.text) : "";

  let body: ReactNode;
  if (restarting) {
    body = (
      <Notice tone="info" icon={<Spinner />} title="Server startet neu …">
        Während des Updates ist Stowly kurz nicht erreichbar. Dieser Abschnitt fragt alle {String(UPDATE_POLL_MS / 1000)} Sekunden nach.
      </Notice>
    );
  } else if (integrations.status === "error") {
    body = (
      <Notice
        tone={integrations.offline ? "warn" : "danger"}
        icon={integrations.offline ? <CloudOffIcon /> : undefined}
        title="Zustand der Updates fehlt"
        role="status"
        action={
          <Button size="sm" onClick={onReload}>
            Erneut versuchen
          </Button>
        }
      >
        {integrations.message}
      </Notice>
    );
  } else if (integrations.status === "loading" || known === null) {
    body = (
      <List>
        <ListRow label={<span className={styles.muted}>Zustand der Updates wird geladen …</span>}>
          <Spinner label="Zustand der Updates wird geladen" />
        </ListRow>
      </List>
    );
  } else if (!known.configured) {
    body = (
      <List>
        <ListRow label="Installierte Version" hint={NOT_CONFIGURED} inline>
          <span className={styles.value}>{known.current}</span>
        </ListRow>
      </List>
    );
  } else {
    const latest = describeLatest(known);
    const page = githubPage(known.url);
    const canInstall = known.available && known.updater_ready && !inFlight && known.latest !== null;
    body = (
      <>
        {stateNotice ? (
          <div ref={stateRef} tabIndex={-1} className={styles.focusTarget}>
            <Notice tone={stateNotice.tone} icon={stateIcon(known)} title={stateNotice.title === "" ? undefined : stateNotice.title}>
              {stateNotice.text === "" ? undefined : stateNotice.text}
            </Notice>
          </div>
        ) : null}
        {known.available && !known.updater_ready && !inFlight ? (
          <Notice tone="warn" icon={<WarningIcon />} title={`Stowly ${known.latest ?? ""} lässt sich nicht installieren`}>
            {sentences(NO_UPDATER, known.updater_seen_at ? `Zuletzt hat er sich am ${formatTimestamp(known.updater_seen_at)} gemeldet.` : "")}
          </Notice>
        ) : null}
        <List>
          <ListRow label="Installierte Version" hint={known.repo ? `Neue Versionen kommen aus ${known.repo} auf GitHub.` : undefined} inline>
            <span className={styles.value}>{known.current}</span>
          </ListRow>
          <ListRow label="Neueste Version" hint={latest.hint}>
            <span className={styles.value}>{latest.value}</span>
            {known.available ? <Badge tone="accent">neu</Badge> : null}
          </ListRow>
          {known.latest !== null && (known.notes !== null || page !== null) ? (
            <ListRow label={`Änderungen in ${known.latest}`} stacked>
              <div className={styles.release}>
                <div className={styles.pushActions}>
                  {known.notes !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconRight={showNotes ? <ChevronUpIcon /> : <ChevronDownIcon />}
                      aria-expanded={showNotes}
                      aria-controls={showNotes ? notesId : undefined}
                      onClick={() => setShowNotes(!showNotes)}
                    >
                      {showNotes ? "Änderungen verbergen" : "Änderungen zeigen"}
                    </Button>
                  ) : null}
                  {page !== null ? (
                    <a className={styles.external} href={page} target="_blank" rel="noopener noreferrer">
                      <ExternalLinkIcon size={16} aria-hidden="true" />
                      Auf GitHub ansehen
                    </a>
                  ) : null}
                </div>
                {/* Klartext, wie ihn GitHub liefert: kein HTML, die Zeilenumbrüche bleiben. */}
                {showNotes && known.notes !== null ? (
                  <div id={notesId} className={styles.notes}>
                    {known.notes}
                  </div>
                ) : null}
              </div>
            </ListRow>
          ) : null}
          <ListRow
            label="Zuletzt gesucht"
            hint={
              <>
                {sentences(
                  known.checked_at ? `Gelungen ${timeAgo(known.checked_at, now)} (${formatTimestamp(known.checked_at)}).` : "Noch keine Suche gelungen.",
                  `Der Server sucht von selbst ${checkIntervalText()}.`,
                )}
                {known.check_error ? <span className={styles.error}> Die letzte Suche ist gescheitert: {known.check_error}</span> : null}
              </>
            }
          >
            <div className={styles.pushActions}>
              <Button ref={checkRef} icon={<RefreshIcon />} busy={checking} disabled={secondsLeft > 0} onClick={() => void check()}>
                Nach Updates suchen
              </Button>
              {secondsLeft > 0 ? <span className={styles.pause}>Nächste Suche in {secondsLeft} s</span> : null}
            </div>
          </ListRow>
          {canInstall ? (
            <ListRow label={`Update auf ${known.latest ?? ""}`} hint="Installiert wird vom Updater auf dem Rechner, nach einer Rückfrage.">
              <Button variant="primary" icon={<DownloadIcon />} onClick={() => setConfirming(true)}>
                Update installieren
              </Button>
            </ListRow>
          ) : null}
        </List>
      </>
    );
  }

  return (
    <Section
      title="Aktualisierung"
      id="aktualisierung"
      description="Neue Versionen von Stowly erscheinen auf GitHub. Der Server sucht danach; installiert wird auf Wunsch vom Updater auf dem Rechner."
    >
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {body}
      {message ? (
        <Notice tone={message.tone} title={message.title} role="status">
          {message.text}
        </Notice>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Update auf ${known?.latest ?? ""} installieren?`}
        confirmLabel="Installieren"
        onConfirm={install}
        errorText={installErrorText}
      >
        <p>{INSTALL_WARNING}</p>
      </ConfirmDialog>
    </Section>
  );
}
