import { useEffect, useRef, useState } from "react";

import { formatTimestamp, HA_MIRROR_DELAY_S, HA_SYNC_INTERVAL_S, useCore, type ConfigSource, type HaConfig, type HaStatus } from "@/contract";
import { List, ListRow, Notice, plural, Section, timeAgo, useNow, useVisibleInterval } from "@/ui";
import { Button, Spinner } from "@/ui/base";
import { CloudOffIcon, WarningIcon } from "@/ui/icons";

import { HaConnectionForm } from "./HaConnectionForm";
import { HaSensorForm } from "./HaSensorForm";
import type { IntegrationsState } from "./integrations";
import { useLoaded, type LoadedResource } from "./loaded";
import styles from "./SettingsPage.module.css";

/** Was die Zeile „Bring! über Home Assistant" sagt, und ob darüber ein Hinweis steht. */
export interface HaText {
  /** Kurz, rechts in der Zeile. */
  value: string;
  /** Ein, zwei Sätze darunter. */
  hint: string;
  /** Ein Hinweis über der Liste, wenn der Abgleich nicht läuft; sonst null. */
  notice: { tone: "warn" | "danger"; title: string; text: string } | null;
}

const SETUP = "STOWLY_HA_URL, STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY";
/** Was bei einer Störung beruhigt: Die Liste in Stowly hängt nicht an Home Assistant. */
const SAFE = "Die Einkaufsliste in Stowly bleibt vollständig; was inzwischen geschieht, gleicht der nächste gelungene Abgleich ab.";

const NUMBER_WORDS = ["null", "eine", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf"];

/** So oft fragt der Abschnitt nach dem Speichern nach, ob der erste Abgleich gelaufen ist. */
export const HA_POLL_MS = 3_000;
/** Höchstens so oft; danach lädt erst „Erneut versuchen" oder das nächste Öffnen. */
const HA_POLL_MAX = 40;

/** Eine Dauer aus dem Vertrag als Text: „zwei Minuten", „eine Minute", sonst „90 Sekunden". */
export function durationText(seconds: number): string {
  if (seconds % 60 !== 0) {
    return plural(seconds, "Sekunde", "Sekunden");
  }
  const minutes = seconds / 60;
  return `${NUMBER_WORDS[minutes] ?? String(minutes)} ${minutes === 1 ? "Minute" : "Minuten"}`;
}

/** Wie oft etwas geschieht: „alle zwei Minuten", „jede Minute". */
export function everyText(seconds: number): string {
  return seconds === 60 ? "jede Minute" : `alle ${durationText(seconds)}`;
}

/** Wie oft der Server Home Assistant fragt (`HA_SYNC_INTERVAL_S`). */
const RETRY = everyText(HA_SYNC_INTERVAL_S);

/** Wie viele Einträge gerade in Bring! stehen (`HaStatus.linked`), als Satz. */
export function linkedText(linked: number): string {
  return linked === 0 ? "Gerade steht kein Eintrag in Bring!." : `Gerade ${linked === 1 ? "steht" : "stehen"} ${plural(linked, "Eintrag", "Einträge")} in Bring!.`;
}

/** Wann der Abgleich zuletzt gelang, als Satz; „noch keiner", solange der Server seit dem Start keinen hatte. */
function lastOkText(ha: Pick<HaStatus, "last_ok_at">, now: number): string {
  return ha.last_ok_at
    ? `Zuletzt gelungen ${timeAgo(ha.last_ok_at, now)} (${formatTimestamp(ha.last_ok_at)}).`
    : "Seit dem Start des Servers ist noch keiner gelungen.";
}

/**
 * Ein Satz je Zustand des Abgleichs mit Home Assistant (`HaStatus.state`, docs/integrationen.md, 5.6).
 * Was zu tun ist, hängt davon ab, woher die Verbindung kommt (`source`): aus der Umgebung ändert sie
 * nur, wer den Server betreibt; aus der App das Formular darunter. Nie ein Token.
 * @param now jetzt, in Millisekunden (für „vor 5 Minuten")
 * @param source woher die Verbindung kommt (`HaConfig.source`); null = unbekannt, wie aus der App
 */
export function describeHa(ha: HaStatus, now: number, source: ConfigSource | null = null): HaText {
  const env = source === "env";
  if (!ha.configured) {
    return ha.problem
      ? {
          value: "aus",
          hint: env ? `Nur halb eingerichtet. Für den Abgleich braucht der Server ${SETUP} (docs/betrieb.md).` : "Nur halb eingerichtet: Unten fehlt noch etwas.",
          notice: { tone: "warn", title: "Der Abgleich mit Bring! ist aus", text: ha.problem },
        }
      : {
          value: "aus",
          hint: "Nicht eingerichtet. Unten Adresse, Token und Liste eintragen. Ohne Home Assistant funktioniert die Einkaufsliste genauso, nur ohne Bring!.",
          notice: null,
        };
  }
  const list = ha.entity ?? "Die Liste";
  const last = lastOkText(ha, now);
  switch (ha.state) {
    case "off":
    case "pending":
      return { value: "eingerichtet", hint: "Seit dem Start oder der letzten Änderung lief noch kein Abgleich; der erste folgt gleich.", notice: null };
    case "ok":
      return { value: "verbunden", hint: `${last} ${linkedText(ha.linked)}`, notice: null };
    case "unauthorized":
      return {
        value: "Token abgelehnt",
        hint: `${env ? "Wer den Server betreibt, prüft STOWLY_HA_TOKEN" : "Unten einen neuen Token eintragen"}: einen langlebigen Zugangs-Token, am besten eines eigenen Benutzers. ${last}`,
        notice: { tone: "danger", title: "Home Assistant lehnt den Token ab", text: SAFE },
      };
    case "not_found":
      return {
        value: "Liste fehlt",
        hint: `Die Liste ${list} gibt es in Home Assistant nicht. ${env ? "Wer den Server betreibt, prüft STOWLY_HA_TODO_ENTITY." : "Unten eine andere wählen."} ${last}`,
        notice: { tone: "danger", title: "Die Liste fehlt in Home Assistant", text: SAFE },
      };
    case "unavailable":
      return {
        value: "Liste nicht verfügbar",
        hint: `Home Assistant meldet die Liste gerade als nicht verfügbar, etwa während eines Neustarts. Stowly versucht es ${RETRY} wieder. ${last}`,
        notice: { tone: "warn", title: "Die Liste ist gerade nicht verfügbar", text: SAFE },
      };
    case "unreachable":
      return {
        value: "nicht erreichbar",
        hint: `Stowly erreicht Home Assistant nicht (Netz, Adresse oder Zertifikat) und versucht es ${RETRY} wieder. ${last}`,
        notice: { tone: "warn", title: "Home Assistant ist nicht erreichbar", text: SAFE },
      };
    case "error":
      return {
        value: "Fehler",
        hint: `Home Assistant hat unerwartet geantwortet. Stowly versucht es ${RETRY} wieder. ${last}`,
        notice: { tone: "danger", title: "Fehler beim Abgleich mit Home Assistant", text: SAFE },
      };
  }
}

function HomeAssistant({ ha, source }: { ha: HaStatus; source: ConfigSource | null }) {
  const now = useNow();
  const text = describeHa(ha, now, source);
  return (
    <>
      {text.notice ? (
        <Notice tone={text.notice.tone} icon={<WarningIcon />} title={text.notice.title} role="status">
          {text.notice.text}
        </Notice>
      ) : null}
      <List>
        <ListRow label="Bring! über Home Assistant" hint={text.hint}>
          <span className={styles.value}>{text.value}</span>
        </ListRow>
        {ha.configured && ha.last_error ? (
          <ListRow label="Letzter Fehler" hint={ha.last_error}>
            <span className={styles.value}>{ha.last_error_at ? formatTimestamp(ha.last_error_at) : "–"}</span>
          </ListRow>
        ) : null}
      </List>
    </>
  );
}

/** Was ohne Server fehlt. */
export const HA_OFFLINE = "Die Einrichtung von Home Assistant kennt nur der Server, und der ist gerade nicht erreichbar.";

export interface HaSetupProps {
  integrations: IntegrationsState;
  onReload: () => void;
  /** Die Einrichtung von HA vom Server (`core.haConfig.load`). */
  config: LoadedResource<HaConfig>;
  /** Etwas hat sich geändert (Verbindung, Sensor): etwa den Stand der Einrichtung neu laden. */
  onChanged?: () => void;
  /** Der Zustand des Abgleichs steht schon darüber (in den Einstellungen): Sein Hinweis wird nicht wiederholt. */
  statusShown?: boolean;
}

/**
 * Verbindung und Sensor (docs/plan-einrichtung-b.md, 3), für die Einstellungen und den Assistenten:
 * lädt die Einrichtung von HA beim Server; nach dem Speichern fragt es nach, bis der erste Abgleich
 * gelaufen ist (`HaStatus.state` nicht mehr "pending"), höchstens zwei Minuten.
 */
export function HaSetup({ integrations, onReload, config, onChanged, statusShown = false }: HaSetupProps) {
  const core = useCore();
  const setup = useLoaded(() => core.setup.load(), "Den Stand der Einrichtung kennt nur der Server.");
  const [watching, setWatching] = useState(false);
  const polls = useRef(0);
  const ha = integrations.status === "ready" ? integrations.value.ha : null;
  const pending = ha?.state === "pending";

  useVisibleInterval(
    () => {
      polls.current += 1;
      onReload();
    },
    HA_POLL_MS,
    watching && pending && polls.current < HA_POLL_MAX,
  );
  useEffect(() => {
    if (watching && ha !== null && !pending) {
      setWatching(false);
    }
  }, [watching, ha, pending]);

  function changed() {
    polls.current = 0;
    setWatching(true);
    onReload();
    onChanged?.();
  }

  function sensorChanged() {
    config.reload();
    onReload();
    onChanged?.();
  }

  if (config.state.status === "error") {
    const old = config.state.code === "not_supported";
    return (
      <Notice
        tone={config.state.offline ? "warn" : old ? "info" : "danger"}
        icon={config.state.offline ? <CloudOffIcon /> : undefined}
        role="status"
        action={
          old ? undefined : (
            <Button size="sm" onClick={config.reload}>
              Erneut versuchen
            </Button>
          )
        }
      >
        {old ? "Dieser Server kann Home Assistant noch nicht aus der App einrichten. Erst Stowly aktualisieren." : config.state.message}
      </Notice>
    );
  }
  if (config.state.status === "loading") {
    return (
      <p className={styles.muted}>
        <Spinner label="Einrichtung von Home Assistant wird geladen" />
      </p>
    );
  }
  const value = config.state.value;
  // Was fehlt (der Token nach einem Zurückspielen, die Adresse, der Sensor-Token), sagt der Server;
  // steht derselbe Satz schon im Zustand darüber, nicht noch einmal.
  const problem = value.problem !== null && !(statusShown && ha !== null && !ha.configured && ha.problem === value.problem) ? value.problem : null;
  return (
    <>
      {problem ? (
        <Notice tone="warn" icon={<WarningIcon />} role="status">
          {problem}
        </Notice>
      ) : null}
      {watching && pending ? (
        <Notice tone="info" icon={<Spinner />} role="status">
          Gespeichert. Der erste Abgleich mit Home Assistant läuft gleich.
        </Notice>
      ) : null}
      <h3 className={styles.subhead}>Verbindung</h3>
      <HaConnectionForm config={value} ha={ha} onSaved={config.set} onChanged={changed} />
      <h3 className={styles.subhead}>Sensor</h3>
      <HaSensorForm config={value} setup={setup.state.status === "ready" ? setup.state.value : null} onChanged={sensorChanged} />
    </>
  );
}

/**
 * „Home Assistant und Bring!": ob und wie die Einkaufsliste über Home Assistant nach Bring! kommt
 * (Zustand vom Server, `core.integrations.load`), darunter die Verbindung (`HaConnectionForm`) und
 * der Sensor samt YAML (`HaSensorForm`). Kommt die Verbindung aus der Umgebung, ist sie nur zu sehen.
 */
export function HomeAssistantSection({ integrations, onReload }: { integrations: IntegrationsState; onReload: () => void }) {
  const core = useCore();
  const config = useLoaded(() => core.haConfig.load(), HA_OFFLINE);
  // Woher die Verbindung kommt, entscheidet, was die Sätze zum Zustand raten.
  const source = config.state.status === "ready" ? config.state.value.source : null;
  return (
    <Section
      title="Home Assistant und Bring!"
      id="home-assistant"
      description="Die Einkaufsliste erscheint über Home Assistant in Bring!, und Home Assistant kann eine Zusammenfassung als Sensor lesen."
    >
      {integrations.status === "loading" ? (
        <List>
          <ListRow label={<span className={styles.muted}>Zustand von Home Assistant wird geladen …</span>}>
            <Spinner label="Zustand von Home Assistant wird geladen" />
          </ListRow>
        </List>
      ) : integrations.status === "error" ? (
        <Notice
          tone={integrations.offline ? "warn" : "danger"}
          icon={integrations.offline ? <CloudOffIcon /> : undefined}
          title="Zustand von Home Assistant fehlt"
          role="status"
          action={
            <Button size="sm" onClick={onReload}>
              Erneut versuchen
            </Button>
          }
        >
          {integrations.message}
        </Notice>
      ) : (
        <HomeAssistant ha={integrations.value.ha} source={source} />
      )}
      <HaSetup integrations={integrations} onReload={onReload} config={config} statusShown />
      <p className={styles.foot}>
        Ein Eintrag der Einkaufsliste erscheint in Bring!, sobald er {durationText(HA_MIRROR_DELAY_S)} offen ist. Wer ihn in Bring! abhakt, erledigt ihn in Stowly.
        Eigene Artikel in Bring! bleiben unberührt: Stowly übernimmt sie nicht und hakt sie nie ab.
      </p>
    </Section>
  );
}
