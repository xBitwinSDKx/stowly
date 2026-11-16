import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { ROUTES, setupPath, setupStepOf, type PiPairing, type SetupStepKey } from "@/contract";
import { PageLoading, usePageTitle } from "@/app/Page";
import { SETUP_LATER_FLAG } from "@/app/setupAutoOpen";
import { errorText, Logo, Notice, useUiFlag } from "@/ui";
import { Button, ButtonLink, IconButton, useToast } from "@/ui/base";
import { CloseIcon, CloudOffIcon, SkipIcon, WarningIcon } from "@/ui/icons";

import { DoneStep } from "./DoneStep";
import { NotifyStep } from "./NotifyStep";
import { PrinterStep } from "./PrinterStep";
import { securePage } from "./navigateAway";
import { SecureStep } from "./SecureStep";
import { SetupProgress } from "./SetupProgress";
import styles from "./SetupPage.module.css";
import { firstOpenStep, nextStep, previousStep, progressOf, STEP_LABELS, stepOf } from "./steps";
import { UpdatesStep } from "./UpdatesStep";
import { SETUP_OFFLINE, useSetup } from "./useSetup";

/**
 * Der Assistent unter /einrichtung/:step (Vollbild wie die Scan-Ansicht): Kopf mit „Später
 * fortsetzen", der Fortschritt, der Schritt, unten Zurück und Überspringen bzw. Weiter.
 *
 * - Ohne Kürzel (oder mit einem unbekannten) öffnet der erste offene Schritt.
 * - Ein Schritt ist erledigt, wenn der Server ihn so sieht (`ready`) oder die App ihn so markiert
 *   hat; „Überspringen" markiert ihn als übersprungen.
 * - Läuft die Seite über HTTPS, markiert der Assistent die sichere Verbindung selbst als erledigt.
 * - Eine Kopplung eines Pi bleibt beim Blättern erhalten.
 * - Der Stand liegt beim Server; ohne ihn sagt die Seite das.
 */
export function SetupPage() {
  usePageTitle("Einrichtung");
  const navigate = useNavigate();
  const toast = useToast();
  const { step: slug } = useParams();
  const setup = useSetup();
  const [, setLater] = useUiFlag(SETUP_LATER_FLAG, false);
  const [pairing, setPairing] = useState<PiPairing | null>(null);
  const [skipping, setSkipping] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const secure = securePage();
  const key = setupStepOf(slug);
  const status = setup.state.status === "ready" ? setup.state.value : null;
  const { update, reload } = setup;

  // Ohne (gültiges) Kürzel: zum ersten offenen Schritt. Das ersetzt auch einen Anker wie #geraet=.
  useEffect(() => {
    if (status !== null && key === null) {
      void navigate(setupPath(firstOpenStep(status, secure)), { replace: true });
    }
  }, [status, key, secure, navigate]);

  // Über HTTPS (auch hinter einem Reverse Proxy) ist die sichere Verbindung erledigt.
  const httpsStep = status ? stepOf(status, "https") : null;
  const markHttps = secure && httpsStep !== null && httpsStep.state !== "done";
  useEffect(() => {
    if (markHttps) {
      update({ step: { id: "https", state: "done" } }).catch(() => undefined);
    }
  }, [markHttps, update]);

  // Ein neuer Schritt: Fokus auf seine Überschrift, damit Tastatur und Screenreader dort weitermachen.
  useEffect(() => {
    if (key !== null) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [key]);

  function later() {
    setLater(true);
    void navigate(ROUTES.stock);
  }

  async function skip(current: Exclude<SetupStepKey, "done">) {
    if (!status) {
      return;
    }
    setSkipping(true);
    try {
      if (stepOf(status, current).state !== "skipped") {
        await update({ step: { id: current, state: "skipped" } });
      }
      void navigate(setupPath(nextStep(current)));
    } catch (caught) {
      toast.show({ message: errorText(caught, { offline: SETUP_OFFLINE }), tone: "danger" });
    } finally {
      setSkipping(false);
    }
  }

  let content;
  if (setup.state.status === "error") {
    const old = setup.state.code === "not_supported" || setup.state.code === "not_found";
    content = (
      <Notice
        tone={setup.state.offline ? "warn" : "danger"}
        icon={setup.state.offline ? <CloudOffIcon /> : <WarningIcon />}
        title={old ? "Dieser Server kennt die Einrichtung noch nicht." : "Die Einrichtung ist gerade nicht möglich."}
        role="status"
        action={
          old ? (
            <ButtonLink size="sm" to={ROUTES.stock}>
              Zu Stowly
            </ButtonLink>
          ) : (
            <Button size="sm" onClick={reload}>
              Erneut versuchen
            </Button>
          )
        }
      >
        {old ? "Erst den Server auf die neue Version aktualisieren." : setup.state.message}
      </Notice>
    );
  } else if (status === null || key === null) {
    content = <PageLoading label="Einrichtung wird geladen …" />;
  } else {
    content = (
      <>
        <h2 id="einrichtung-schritt" ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
          {STEP_LABELS[key]}
        </h2>
        {key === "https" ? <SecureStep status={status} update={update} secure={secure} /> : null}
        {key === "printer" ? (
          <PrinterStep
            pairing={pairing}
            onPairing={setPairing}
            onPaired={() => {
              update({ step: { id: "printer", state: "done" } }).catch(() => undefined);
            }}
          />
        ) : null}
        {key === "updates" ? <UpdatesStep onChanged={reload} /> : null}
        {key === "notifications" ? <NotifyStep onChanged={reload} /> : null}
        {key === "done" ? <DoneStep status={status} update={update} secure={secure} /> : null}
      </>
    );
  }

  const previous = key === null ? null : previousStep(key);
  const current = key === null || key === "done" ? null : key;
  const done = status !== null && current !== null && progressOf(stepOf(status, current), secure) === "done";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
        <h1 className={styles.title}>Einrichtung</h1>
        <IconButton label="Später fortsetzen" onClick={later}>
          <CloseIcon />
        </IconButton>
      </header>
      {status !== null && key !== null ? <SetupProgress status={status} current={key} secure={secure} /> : <div />}
      <main className={styles.main} aria-labelledby={key !== null && status !== null ? "einrichtung-schritt" : undefined}>
        {content}
      </main>
      {status !== null && key !== null ? (
        <footer className={styles.footer}>
          {previous !== null ? <ButtonLink to={setupPath(previous)}>Zurück</ButtonLink> : null}
          {current !== null ? (
            <div className={styles.footerEnd}>
              {done ? (
                <ButtonLink variant="primary" to={setupPath(nextStep(current))}>
                  Weiter
                </ButtonLink>
              ) : (
                <Button icon={<SkipIcon />} busy={skipping} onClick={() => void skip(current)}>
                  Überspringen
                </Button>
              )}
            </div>
          ) : null}
        </footer>
      ) : (
        <div />
      )}
    </div>
  );
}
