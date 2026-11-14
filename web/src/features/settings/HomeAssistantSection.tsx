import { formatTimestamp, HA_MIRROR_DELAY_S, HA_SYNC_INTERVAL_S, type HaStatus } from "@/contract";
import { List, ListRow, Notice, plural, Section, timeAgo, useNow } from "@/ui";
import { Button, Spinner } from "@/ui/base";
import { CloudOffIcon, WarningIcon } from "@/ui/icons";

import type { IntegrationsState } from "./integrations";
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
 * Adresse und Token von Home Assistant kennt die App nicht; sie nennt nur, was der Server meldet.
 * @param now jetzt, in Millisekunden (für „vor 5 Minuten")
 */
export function describeHa(ha: HaStatus, now: number): HaText {
  if (!ha.configured) {
    return ha.problem
      ? {
          value: "aus",
          hint: `Nur halb eingerichtet. Für den Abgleich braucht der Server ${SETUP} (docs/betrieb.md).`,
          notice: { tone: "warn", title: "Der Abgleich mit Bring! ist aus", text: ha.problem },
        }
      : {
          value: "aus",
          hint: `Nicht eingerichtet. Wer den Server betreibt, richtet es mit ${SETUP} ein (docs/betrieb.md). Ohne Home Assistant funktioniert die Einkaufsliste genauso, nur ohne Bring!.`,
          notice: null,
        };
  }
  const list = ha.entity ?? "Die Liste";
  const last = lastOkText(ha, now);
  switch (ha.state) {
    case "off":
    case "pending":
      return { value: "eingerichtet", hint: "Seit dem Start des Servers lief noch kein Abgleich; der erste folgt in wenigen Minuten.", notice: null };
    case "ok":
      return { value: "verbunden", hint: `${last} ${linkedText(ha.linked)}`, notice: null };
    case "unauthorized":
      return {
        value: "Token abgelehnt",
        hint: `Wer den Server betreibt, prüft STOWLY_HA_TOKEN: einen langlebigen Zugangs-Token, am besten eines eigenen Benutzers. ${last}`,
        notice: { tone: "danger", title: "Home Assistant lehnt den Token ab", text: SAFE },
      };
    case "not_found":
      return {
        value: "Liste fehlt",
        hint: `Die Liste ${list} gibt es in Home Assistant nicht. Wer den Server betreibt, prüft STOWLY_HA_TODO_ENTITY. ${last}`,
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

function HomeAssistant({ ha }: { ha: HaStatus }) {
  const now = useNow();
  const text = describeHa(ha, now);
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
        {ha.entity !== null ? (
          <ListRow label="Liste in Home Assistant" inline>
            <code className={styles.value}>{ha.entity}</code>
          </ListRow>
        ) : null}
        {ha.configured && ha.last_error ? (
          <ListRow label="Letzter Fehler" hint={ha.last_error}>
            <span className={styles.value}>{ha.last_error_at ? formatTimestamp(ha.last_error_at) : "–"}</span>
          </ListRow>
        ) : null}
        <ListRow
          label="Sensor für Home Assistant"
          hint={
            ha.sensor
              ? "Home Assistant liest eine Zusammenfassung (bald fällig, abgelaufen, Einkaufsliste) mit einem eigenen Token, der nur dafür gilt."
              : "Nicht eingerichtet. Wer den Server betreibt, setzt dafür STOWLY_HA_SUMMARY_TOKEN (docs/betrieb.md)."
          }
          inline
        >
          <span className={styles.value}>{ha.sensor ? "eingerichtet" : "aus"}</span>
        </ListRow>
      </List>
    </>
  );
}

/**
 * „Home Assistant und Bring!": ob und wie die Einkaufsliste über Home Assistant nach Bring! kommt,
 * und ob der Sensor eingerichtet ist. Den Zustand meldet der Server (`core.integrations.load`); ohne
 * ihn sagt der Abschnitt, dass er fehlt. Adresse und Token von Home Assistant stehen nie hier.
 */
export function HomeAssistantSection({ integrations, onReload }: { integrations: IntegrationsState; onReload: () => void }) {
  return (
    <Section
      title="Home Assistant und Bring!"
      id="home-assistant"
      description="Die Einkaufsliste erscheint über Home Assistant in Bring!, und Home Assistant kann eine Zusammenfassung als Sensor lesen. Eingerichtet wird beides auf dem Server."
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
        <HomeAssistant ha={integrations.value.ha} />
      )}
      <p className={styles.foot}>
        Ein Eintrag der Einkaufsliste erscheint in Bring!, sobald er {durationText(HA_MIRROR_DELAY_S)} offen ist. Wer ihn in Bring! abhakt, erledigt ihn in Stowly.
        Eigene Artikel in Bring! bleiben unberührt: Stowly übernimmt sie nicht und hakt sie nie ab.
      </p>
    </Section>
  );
}
