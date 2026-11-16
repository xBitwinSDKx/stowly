import { useEffect, useState } from "react";

import { checkNotifyTime, isTimeOfDay } from "@/contract";
import { deviceTimeZone, errorText, ListRow, otherTimeZone } from "@/ui";
import { TextField } from "@/ui/base";

import type { IntegrationsState } from "./integrations";
import styles from "./SettingsPage.module.css";

/** Vorgabe, wenn der Haushalt noch keine Uhrzeit kennt (wie im Server). */
export const DEFAULT_NOTIFY_TIME = "17:00";

/**
 * Liest eine Uhrzeit, wie sie getippt wird: „17:00", „17.00", „1700", „17" oder „7:30" wird zu "HH:MM".
 * Das Feld ist eines für Uhrzeiten und liefert schon "HH:MM"; wo ein Browser nur ein Textfeld zeigt,
 * hilft das beim Tippen. Was keine Uhrzeit ist, kommt unverändert zurück und scheitert an der Prüfung.
 */
export function readTime(text: string): string {
  const trimmed = text.trim();
  const match = /^(\d{1,2})(?:[:.,h ]?(\d{2}))?$/.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const time = `${(match[1] ?? "").padStart(2, "0")}:${match[2] ?? "00"}`;
  return isTimeOfDay(time) ? time : trimmed;
}

/**
 * Was unter der Uhrzeit steht: wann die Nachricht kommt, an wen und nur bei Neuem; wann sie
 * ausfällt (docs/integrationen.md, 1.4 und 4.8). Die Uhrzeit gilt in der Zeitzone des Servers;
 * weicht sie von der des Geräts ab, steht sie dabei.
 * @param pushConfigured ob der Server für Push eingerichtet ist (einen Kontakt für die Push-Dienste hat); null = unbekannt
 */
export function notifyTimeHint(time: string, serverZone: string | null, pushConfigured: boolean | null, deviceZone: string = deviceTimeZone()): string {
  const zone = otherTimeZone(serverZone, deviceZone);
  const when = zone === null ? `Täglich um ${time}` : `Täglich um ${time} (Zeit des Servers, ${zone})`;
  const parts = [
    `${when} an die Geräte mit eingeschalteten Benachrichtigungen, aber nur, wenn seit der letzten Nachricht etwas neu bald abläuft oder abgelaufen ist.`,
    // Das Fenster zum Nachholen: bis 21 Uhr, bei einer späten Uhrzeit eine Stunde, nie über Mitternacht.
    time < "21:00"
      ? "War der Server zu dieser Zeit aus, kommt sie später, aber nur bis 21 Uhr."
      : "War der Server zu dieser Zeit aus, kommt sie höchstens eine Stunde später und nicht nach Mitternacht.",
  ];
  if (pushConfigured === false) {
    // Der Kontakt geht auch in der App (docs/integrationen.md, 12), nicht nur über STOWLY_PUSH_CONTACT.
    parts.push(
      "Der Server hat noch keine Kontakt-Adresse für die Push-Dienste: Bis dahin kommt keine. Eintragen lässt sie sich unter „Einrichtung und Zugang“ oder im Schritt „Benachrichtigungen“ der Einrichtung.",
    );
  }
  return parts.join(" ");
}

export interface NotifyTimeSettingProps {
  /** Die Uhrzeit des Haushalts, "HH:MM" (`HouseholdSettings.notify_time`). */
  value: string;
  integrations: IntegrationsState;
  onCommit: (time: string) => void;
}

/**
 * Die Uhrzeit der täglichen Nachricht in den Einstellungen des Haushalts. Übernommen wird beim
 * Verlassen des Felds oder mit Enter, geprüft nach dem Vertrag (`checkNotifyTime`). Offline gilt
 * die Änderung sofort auf diesem Gerät und erreicht den Server mit dem nächsten Abgleich.
 */
export function NotifyTimeSetting({ value, integrations, onCommit }: NotifyTimeSettingProps) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);

  // Wert von außen geändert (Abgleich mit einem anderen Gerät): Feld nachziehen.
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);

  function commit() {
    const next = readTime(text);
    try {
      checkNotifyTime(next);
    } catch (caught) {
      setError(errorText(caught));
      return;
    }
    setError(null);
    setText(next);
    if (next !== value) {
      onCommit(next);
    }
  }

  const ready = integrations.status === "ready" ? integrations.value : null;
  const hint = notifyTimeHint(value, ready?.timezone ?? null, ready ? ready.push.configured : null);
  return (
    <ListRow
      label="Uhrzeit der Tagesnachricht"
      hint={
        error ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : (
          hint
        )
      }
    >
      <TextField
        className={styles.time}
        label="Uhrzeit der Tagesnachricht"
        hideLabel
        type="time"
        step={60}
        autoComplete="off"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </ListRow>
  );
}
