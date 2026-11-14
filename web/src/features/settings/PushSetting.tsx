import { useEffect, useReducer, useRef, useState } from "react";

import { formatTimestamp, isCoreError, PUSH_TEST_INTERVAL_S, ROUTES, useCore, useLive, type PushState, type PushTestResult } from "@/contract";
import { errorText, ListRow, Notice, timeAgo, useNow, type NoticeTone } from "@/ui";
import { Button, ButtonLink, useToast } from "@/ui/base";
import { BellOffIcon, BellRingIcon, SendIcon, ShareIcon } from "@/ui/icons";

import type { IntegrationsState } from "./integrations";
import styles from "./SettingsPage.module.css";

/** Was die Zeile „Benachrichtigungen" rechts zeigt und darunter erklärt. */
export interface PushText {
  value: string;
  hint: string;
}

const DAILY = "Höchstens eine Nachricht am Tag, und nur, wenn seit der letzten etwas neu bald abläuft oder abgelaufen ist. Gilt nur für dieses Gerät.";

/**
 * Die Zeile „Benachrichtigungen" je Zustand (`core.push.state`, docs/integrationen.md, Abschnitt 4).
 * Wo es nicht geht, sagt sie warum, statt einen Knopf zu zeigen, der nichts tut.
 * @param secureContext `app.state.secure_context`: Ohne sicheren Kontext gibt es kein Push.
 */
export function describePush(state: PushState | undefined, secureContext: boolean | undefined): PushText {
  switch (state) {
    case undefined:
      return { value: "wird geprüft", hint: "Ob dieser Browser Benachrichtigungen kann, wird gerade geprüft." };
    case "unsupported":
      return secureContext === false
        ? { value: "nicht möglich", hint: "Über eine http-Adresse lässt der Browser keine Benachrichtigungen zu. Über die HTTPS-Adresse von Stowly geht es." }
        : {
            value: "nicht möglich",
            hint: "Dieser Browser kann hier keine Benachrichtigungen empfangen. Es geht mit einem aktuellen Chrome, Edge, Firefox oder Safari über die HTTPS-Adresse von Stowly, auf dem iPhone ab iOS 16.4.",
          };
    case "ios_install":
      return {
        value: "erst installieren",
        hint: "Auf iPhone und iPad kommen Benachrichtigungen nur zu Stowly auf dem Home-Bildschirm (ab iOS 16.4). Zuerst Stowly zum Home-Bildschirm hinzufügen, dann Stowly von dort öffnen und hier einschalten.",
      };
    case "not_configured":
      return {
        value: "nicht eingerichtet",
        hint: "Der Server ist nicht für Benachrichtigungen eingerichtet. Wer ihn betreibt, setzt dafür STOWLY_PUSH_CONTACT (docs/betrieb.md).",
      };
    case "off":
      return { value: "aus", hint: DAILY };
    case "on":
      return { value: "an", hint: DAILY };
    case "denied":
      return {
        value: "blockiert",
        hint: "Die Erlaubnis für Benachrichtigungen ist in diesem Browser verweigert. Erteilen lässt sie sich nur in seinen Einstellungen: in Chrome, Edge und Firefox über das Symbol links neben der Adresse, auf dem iPhone unter Einstellungen › Mitteilungen › Stowly. Stowly bemerkt die neue Erlaubnis von selbst, neu laden ist nicht nötig.",
      };
  }
}

/** Eine Meldung unter den Schaltflächen. */
interface PushMessage {
  tone: NoticeTone;
  title: string;
  text: string;
}

/** Was der Push-Dienst auf die Testnachricht geantwortet hat (`PushTestResult.status`, docs/integrationen.md, 4.7), als Satz. */
export function testMessage(result: PushTestResult): PushMessage {
  const code = result.http_status === null ? "" : ` (${String(result.http_status)})`;
  switch (result.status) {
    case "sent":
      return {
        tone: "success",
        title: "Testnachricht verschickt",
        text: "Der Push-Dienst hat sie angenommen; sie sollte gleich auf diesem Gerät erscheinen. Kommt nichts an, die Mitteilungen des Geräts für diesen Browser prüfen.",
      };
    case "gone":
      return {
        tone: "warn",
        title: "Das Abo ist erloschen",
        text: "Der Push-Dienst kennt dieses Gerät nicht mehr; der Server hat das Abo gelöscht. Benachrichtigungen sind deshalb aus und lassen sich neu einschalten.",
      };
    case "rejected":
      return { tone: "danger", title: "Vom Push-Dienst abgelehnt", text: `Der Push-Dienst hat die Nachricht abgelehnt${code}. Meldung des Servers: ${result.message}` };
    case "failed":
      return { tone: "warn", title: "Nicht zugestellt", text: `Der Push-Dienst war nicht erreichbar oder überlastet${code}. Später noch einmal versuchen. Meldung des Servers: ${result.message}` };
  }
}

/** Sekunden bis `until` (Millisekunden), jede Sekunde neu gezeichnet; 0, sobald die Zeit um ist. */
function useSecondsLeft(until: number): number {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  useEffect(() => {
    if (left <= 0) {
      return;
    }
    // Bis die angezeigte Zahl wechselt.
    const timer = setTimeout(tick, (until - Date.now()) % 1000 || 1000);
    return () => clearTimeout(timer);
  });
  return left;
}

/**
 * „Benachrichtigungen" unter „Dieses Gerät": Push einschalten, ausschalten, Testnachricht.
 *
 * Einschalten ruft `push.enable()` unmittelbar im Klick-Handler auf, ohne vorher zu warten: Nur
 * auf einen Tipp hin fragt der Browser nach der Erlaubnis. Einschalten und Testnachricht brauchen
 * den Server; Ausschalten gelingt auch ohne. Nach einer Testnachricht ruht der Knopf
 * `PUSH_TEST_INTERVAL_S` Sekunden, nach „zu viele" so lange, wie der Server sagt.
 */
export function PushSetting({ integrations }: { integrations: IntegrationsState }) {
  const core = useCore();
  const toast = useToast();
  const state = useLive(core.push.state);
  const app = useLive(core.app.state);
  const online = useLive(core.sync.status)?.online;
  const now = useNow();
  const [busy, setBusy] = useState<"enable" | "disable" | "test" | null>(null);
  const [message, setMessage] = useState<PushMessage | null>(null);
  const [pauseUntil, setPauseUntil] = useState(0);
  const secondsLeft = useSecondsLeft(pauseUntil);
  /** Nach Ein- oder Ausschalten wechseln die Schaltflächen: Der Fokus geht an die erste neue. */
  const [refocus, setRefocus] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (refocus && busy === null) {
      actionsRef.current?.querySelector<HTMLElement>("button:not(:disabled), a")?.focus();
      setRefocus(false);
    }
  }, [refocus, busy, state]);

  const text = describePush(state, app?.secure_context);
  const offline = online === false;
  const push = integrations.status === "ready" ? integrations.value.push : null;

  function enable() {
    // Zuerst, ohne zu warten: Sonst fragt der Browser nicht nach der Erlaubnis.
    const answer = core.push.enable();
    setBusy("enable");
    setMessage(null);
    answer
      .then((result) => {
        if (result === "on") {
          toast.show({ message: "Benachrichtigungen sind auf diesem Gerät eingeschaltet.", tone: "success" });
          setRefocus(true);
        } else if (result === "denied") {
          setMessage({ tone: "warn", title: "Keine Erlaubnis", text: "Der Browser hat die Erlaubnis verweigert. Erteilen lässt sie sich nur in seinen Einstellungen, wie oben beschrieben." });
        } else {
          setMessage({ tone: "info", title: "Nicht eingeschaltet", text: "Die Frage des Browsers wurde ohne Antwort geschlossen. Zum Einschalten noch einmal tippen und „Erlauben“ wählen." });
        }
      })
      .catch((caught: unknown) => {
        setMessage({
          tone: isCoreError(caught, "offline") ? "warn" : "danger",
          title: "Nicht eingeschaltet",
          text: errorText(caught, {
            offline: "Zum Einschalten braucht es den Server, und der ist gerade nicht erreichbar.",
            not_configured: "Der Server ist nicht für Benachrichtigungen eingerichtet.",
          }),
        });
      })
      .finally(() => setBusy(null));
  }

  async function disable() {
    setBusy("disable");
    setMessage(null);
    try {
      await core.push.disable();
      toast.show({ message: "Benachrichtigungen sind auf diesem Gerät aus." });
      setRefocus(true);
    } catch (caught) {
      setMessage({ tone: "danger", title: "Nicht ausgeschaltet", text: errorText(caught) });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setMessage(null);
    try {
      const result = await core.push.test();
      setPauseUntil(Date.now() + PUSH_TEST_INTERVAL_S * 1000);
      setMessage(testMessage(result));
      if (result.status === "gone") {
        setRefocus(true);
      }
    } catch (caught) {
      if (isCoreError(caught, "rate_limited")) {
        const wait = typeof caught.details.retry_after_s === "number" && caught.details.retry_after_s > 0 ? caught.details.retry_after_s : PUSH_TEST_INTERVAL_S;
        setPauseUntil(Date.now() + wait * 1000);
        setMessage({ tone: "info", title: "Gerade erst geschickt", text: `Eine Testnachricht geht höchstens alle ${String(PUSH_TEST_INTERVAL_S)} Sekunden. Bitte kurz warten.` });
      } else {
        setMessage({
          tone: isCoreError(caught, "offline") ? "warn" : "danger",
          title: "Keine Testnachricht",
          text: errorText(caught, {
            offline: "Die Testnachricht schickt der Server, und der ist gerade nicht erreichbar.",
            not_found: "Der Server kennt das Abo dieses Geräts nicht mehr. Bitte aus- und wieder einschalten.",
            not_configured: "Der Server ist nicht für Benachrichtigungen eingerichtet.",
          }),
        });
      }
    } finally {
      setBusy(null);
    }
  }

  // Was der Server über Push weiß: wann die letzte Tagesnachricht kam, und warum Push aus ist.
  const lastSent = state === "on" && push?.last_sent_at ? ` Letzte Tagesnachricht: ${timeAgo(push.last_sent_at, now)} (${formatTimestamp(push.last_sent_at)}).` : "";
  const problem = state === "not_configured" && push?.problem ? ` ${push.problem}` : "";
  const needsServer = offline && (state === "off" || state === "on") ? " Gerade ist der Server nicht erreichbar: Einschalten und Testnachricht gehen erst wieder mit ihm." : "";

  let controls = null;
  if (state === "off") {
    controls = (
      <Button icon={<BellRingIcon />} busy={busy === "enable"} disabled={offline} onClick={enable}>
        Einschalten
      </Button>
    );
  } else if (state === "on") {
    controls = (
      <>
        <Button icon={<SendIcon />} busy={busy === "test"} disabled={offline || secondsLeft > 0 || busy !== null} onClick={() => void sendTest()}>
          Testnachricht senden
        </Button>
        <Button variant="ghost" icon={<BellOffIcon />} busy={busy === "disable"} disabled={busy !== null && busy !== "disable"} onClick={() => void disable()}>
          Ausschalten
        </Button>
        {secondsLeft > 0 ? <span className={styles.pause}>Nächste Testnachricht in {secondsLeft} s</span> : null}
      </>
    );
  } else if (state === "ios_install") {
    controls = (
      <ButtonLink to={{ pathname: ROUTES.settings, hash: "#app" }} icon={<ShareIcon />}>
        Anleitung unter „Diese App“
      </ButtonLink>
    );
  }

  // Ein einzelner Knopf steht rechts wie in den übrigen Zeilen; mehrere oder eine Meldung darunter.
  const stacked = message !== null || state === "on" || state === "ios_install";
  return (
    <ListRow label="Benachrichtigungen" hint={`${text.hint}${problem}${lastSent}${needsServer}`} stacked={stacked}>
      {controls !== null || message !== null ? (
        <div className={styles.push}>
          {controls !== null ? (
            <div ref={actionsRef} className={styles.pushActions}>
              {controls}
            </div>
          ) : null}
          {message ? (
            <Notice tone={message.tone} title={message.title} role="status">
              {message.text}
            </Notice>
          ) : null}
        </div>
      ) : (
        <span className={styles.value}>{text.value}</span>
      )}
    </ListRow>
  );
}
