import { useEffect, useRef, useState } from "react";

import { isAppleMobile, useCore, useLive, type PiInfo, type PiPairing, type Printer, type PrinterProbe } from "@/contract";
import { useSecondsLeft } from "@/features/settings/PushSetting";
import { errorText, Notice, useVisibleInterval } from "@/ui";
import { Button, Spinner } from "@/ui/base";
import { CircleCheckIcon, InfoIcon, LockOpenIcon, PlugIcon, RefreshIcon, WarningIcon } from "@/ui/icons";
import { CopyField } from "@/ui/CopyField";

import { ProblemNotice } from "./PrinterCard";
import styles from "./PrintersPage.module.css";

/** So oft fragt die App nach, solange der Pi wartet oder sich einrichtet (nur bei sichtbarer Seite). */
export const PAIRING_POLL_MS = 3_000;

/** Die Restzeit eines Codes: „9:41". */
export function countdownText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

/** „Gekoppelt: QL-570 am Pi stowly-pi (192.168.1.10)", zur Kontrolle, dass es der richtige Pi ist. */
export function pairedText(pi: PiInfo): string {
  const address = pi.addresses[0];
  return `Gekoppelt: ${pi.model ?? "Drucker"} am Pi ${pi.hostname}${address ? ` (${address})` : ""}`;
}

type ProbeState = { status: "busy" } | { status: "done"; probe: PrinterProbe } | { status: "failed"; message: string };

export interface PairPiProps {
  /** Die laufende Kopplung. Der Aufrufer hält sie, damit sie das Blättern im Assistenten übersteht. */
  pairing: PiPairing | null;
  onPairing: (pairing: PiPairing | null) => void;
  /** Einen vorhandenen direkten Drucker übernehmen (neu koppeln); null legt einen neuen an. */
  printerId?: string | null;
  /** Der Pi ist gekoppelt (einmal je Kopplung). */
  onPaired?: (pairing: PiPairing) => void;
  /** Die Anleitung zur SD-Karte zeigen; beim Neu-Koppeln eines vorhandenen Pi nicht nötig. Vorgabe true. */
  sdCard?: boolean;
}

/**
 * Einen Raspberry Pi koppeln (docs/sync-protokoll.md, 11.8): SD-Karte vorbereiten, Code erzeugen,
 * den Befehl auf dem Pi ausführen. Die App fragt dann alle 3 Sekunden nach (nur bei sichtbarer
 * Seite), bis der Pi gekoppelt ist; der Drucker kommt mit dem Abgleich. Gibt es noch keinen
 * Standarddrucker, wird es der neue. Danach „Verbindung prüfen"; über http geht das nicht.
 */
export function PairPi({ pairing, onPairing, printerId = null, onPaired, sdCard = true }: PairPiProps) {
  const core = useCore();
  const app = useLive(core.app.state);
  const printers = useLive(core.data.printers);
  const settings = useLive(core.data.settings);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [madeDefault, setMadeDefault] = useState(false);
  const state = pairing?.state;
  const waiting = state === "waiting" || state === "installing";
  const secondsLeft = useSecondsLeft(waiting && pairing ? Date.parse(pairing.expires_at) : 0);
  const iphone = typeof navigator !== "undefined" && isAppleMobile(navigator);
  const printer: Printer | undefined = state === "paired" && pairing?.printer_id ? printers?.find((candidate) => candidate.id === pairing.printer_id) : undefined;

  const current = useRef(pairing);
  useEffect(() => {
    current.current = pairing;
  });

  // Solange der Pi wartet oder sich einrichtet: nachfragen. Code und Befehl stehen nur in der
  // Antwort auf das Erzeugen; sie bleiben. Eine Antwort zu einer älteren Kopplung zählt nicht mehr.
  useVisibleInterval(
    () => {
      const asked = current.current;
      if (!asked) {
        return;
      }
      core.printers.pairing(asked.id).then(
        (next) => {
          if (current.current?.id === asked.id) {
            onPairing({ ...next, code: asked.code, command: asked.command });
          }
        },
        // Ohne Server: beim nächsten Takt noch einmal.
        () => undefined,
      );
    },
    PAIRING_POLL_MS,
    waiting,
  );

  // Gekoppelt: einmal melden.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (pairing?.state !== "paired" || announced.current === pairing.id) {
      return;
    }
    announced.current = pairing.id;
    onPaired?.(pairing);
  }, [pairing, onPaired]);

  // Ein neuer Drucker wird Standarddrucker, wenn es keinen gibt; erst, wenn er hier angekommen ist.
  const defaulted = useRef(false);
  useEffect(() => {
    if (!printer || printerId !== null || !settings || settings.default_printer_id !== null || defaulted.current) {
      return;
    }
    defaulted.current = true;
    core.settings.update({ default_printer_id: printer.id }).then(
      () => setMadeDefault(true),
      () => undefined,
    );
  }, [printer, printerId, settings, core]);

  async function create() {
    setCreating(true);
    setError(null);
    setProbe(null);
    try {
      onPairing(await core.printers.pair({ origin: window.location.origin, printer_id: printerId }));
    } catch (caught) {
      setError(
        errorText(caught, {
          offline: "Den Code erzeugt der Server, und der ist gerade nicht erreichbar.",
          not_configured: "Dem Server fehlen dafür die CA oder das Paket für den Pi (docs/betrieb.md).",
        }),
      );
    } finally {
      setCreating(false);
    }
  }

  async function runProbe(target: Printer) {
    setProbe({ status: "busy" });
    try {
      setProbe({ status: "done", probe: await core.printers.probe(target.id) });
    } catch (caught) {
      setProbe({ status: "failed", message: errorText(caught, { not_found: "Diesen Drucker gibt es nicht mehr." }) });
    }
  }

  const fresh = !pairing || state === "expired" || state === "cancelled";
  const done = probe?.status === "done" ? probe.probe : null;

  return (
    <div className={styles.pair}>
      {sdCard ? (
        <section className={styles.pairBlock}>
          <h3 className={styles.pairTitle}>1. SD-Karte vorbereiten</h3>
          <ol className={styles.pairSteps}>
            <li>Im Raspberry Pi Imager das Modell wählen, „Raspberry Pi OS Lite (64-bit)“ und die SD-Karte.</li>
            <li>In den Anpassungen: Hostname, der mit „stowly“ beginnt (z. B. stowly-pi), Benutzer mit Passwort, Heim-WLAN, SSH an.</li>
            <li>Den Drucker per USB anschließen, den Pi einschalten.</li>
          </ol>
        </section>
      ) : null}
      <section className={styles.pairBlock}>
        <h3 className={styles.pairTitle}>{sdCard ? "2. Befehl auf dem Pi" : "Befehl auf dem Pi"}</h3>
        {fresh ? (
          <>
            {state === "expired" ? (
              <Notice tone="warn" role="status" icon={<WarningIcon />}>
                Der Code ist abgelaufen.
              </Notice>
            ) : state === "cancelled" ? (
              <Notice tone="warn" role="status" icon={<WarningIcon />}>
                Dieser Code gilt nicht mehr; es gibt einen neueren.
              </Notice>
            ) : null}
            <p className={styles.muted}>Der Befehl lädt alles Nötige von Stowly, richtet den Pi als Druckdienst ein und meldet ihn mit einem Code an. Der Code gilt 30 Minuten.</p>
            <div className={styles.pairActions}>
              <Button variant="primary" icon={pairing ? <RefreshIcon /> : undefined} busy={creating} onClick={() => void create()}>
                {pairing ? "Neuer Code" : "Code erzeugen"}
              </Button>
            </div>
          </>
        ) : null}
        {pairing && waiting ? (
          <>
            {pairing.command ? <CopyField value={pairing.command} label="Befehl für den Pi" /> : null}
            <p className={styles.muted}>Gültig noch {countdownText(secondsLeft)}</p>
            <p>
              Am PC die Eingabeaufforderung öffnen: <code className={styles.code}>ssh benutzer@stowly-pi.local</code>, den Befehl einfügen, Enter.
            </p>
            {iphone ? (
              <Notice tone="info" icon={<InfoIcon />}>
                Auf dem iPhone fehlt ein Terminal: diesen Schritt am PC machen.
              </Notice>
            ) : null}
            <p className={styles.pairWaiting} role="status">
              <Spinner size={18} />
              {state === "installing" ? `Der Pi richtet sich ein …${pairing.pi ? ` (${pairing.pi.hostname})` : ""}` : "Wartet auf den Pi …"}
            </p>
          </>
        ) : null}
        {pairing && state === "paired" ? (
          <>
            <Notice tone="success" role="status" icon={<CircleCheckIcon />} title={pairing.pi ? pairedText(pairing.pi) : "Gekoppelt"}>
              {madeDefault ? <p>Ist jetzt Standarddrucker.</p> : null}
              {pairing.pi && !pairing.pi.printer_found ? <p>Am Pi hing beim Koppeln kein Etikettendrucker: ihn per USB anschließen und einschalten.</p> : null}
            </Notice>
            {!printer ? (
              <p className={styles.pairWaiting} role="status">
                <Spinner size={18} />
                Der Drucker kommt mit dem nächsten Abgleich …
              </p>
            ) : app?.secure_context === false ? (
              <Notice tone="info" icon={<LockOpenIcon />}>
                Prüfen und Drucken gehen nur über die sichere Adresse.
              </Notice>
            ) : (
              <>
                <div className={styles.pairActions}>
                  <Button icon={<PlugIcon />} busy={probe?.status === "busy"} onClick={() => void runProbe(printer)}>
                    Verbindung prüfen
                  </Button>
                </div>
                {done && done.problem === null ? (
                  <Notice tone="success" role="status" icon={<CircleCheckIcon />} title="Der Druckdienst antwortet.">
                    {done.url ? `Erreicht über ${done.url}.` : null}
                  </Notice>
                ) : null}
                {done && done.problem !== null ? <ProblemNotice problem={done.problem} printer={printer} fallback={done.error} pendingOwn={0} /> : null}
                {probe?.status === "failed" ? (
                  <Notice tone="danger" role="alert">
                    {probe.message}
                  </Notice>
                ) : null}
              </>
            )}
          </>
        ) : null}
        {error ? (
          <Notice tone="danger" role="alert" icon={<WarningIcon />}>
            {error}
          </Notice>
        ) : null}
      </section>
    </div>
  );
}
