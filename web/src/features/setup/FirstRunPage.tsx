import { useEffect, useState, type FormEvent } from "react";

import { isCoreError, LIMITS, useCore } from "@/contract";
import { suggestDeviceName, waitText } from "@/features/auth";
import styles from "@/features/auth/LoginPage.module.css";
import { FilePicker } from "@/features/backup/files";
import { RestoreFlow } from "@/features/backup/RestoreFlow";
import { errorText, Logo, Notice } from "@/ui";
import { Button, Card, IconButton, TextField, useToast } from "@/ui/base";
import { EyeIcon, EyeOffIcon, InfoIcon, RestoreIcon, WarningIcon } from "@/ui/icons";

import setupStyles from "./SetupPage.module.css";

/** Der Satz zu einem Fehler beim Festlegen des ersten Passworts. */
export function firstRunErrorText(error: unknown): string {
  if (isCoreError(error, "rate_limited")) {
    const seconds = Number(error.details.retry_after_s);
    return `Zu viele Versuche. Nächster Versuch in ${waitText(Number.isFinite(seconds) && seconds > 0 ? seconds : 60)}.`;
  }
  return errorText(error, {
    offline: "Der Server ist nicht erreichbar. Zum Festlegen braucht es eine Verbindung zum Server.",
    protocol_mismatch: "Diese Version der App passt nicht zum Server. Bitte die Seite neu laden.",
    internal: "Das Passwort ließ sich nicht festlegen. Bitte noch einmal versuchen.",
  });
}

export interface FirstRunPageProps {
  /**
   * Wird gerufen, bevor das Passwort beim Server landet: Die App wechselt dann schon zur
   * Einrichtung, damit nach der Anmeldung nicht kurz der Bestand aufblitzt.
   */
  onFirstRun?: () => void;
  /**
   * Die Seite spielt gerade eine Sicherung ein (true) oder nicht mehr (false): Solange soll die
   * Anmeldeschranke sie zeigen, auch wenn der Server nach dem Neustart schon ein Passwort meldet.
   */
  onBusy?: (busy: boolean) => void;
}

/**
 * „Willkommen bei Stowly": Der Server hat noch kein Haushalts-Passwort (`server_configured ===
 * false`). Wer die Seite zuerst öffnet, legt es fest, und dieses Gerät ist damit angemeldet.
 * Ist inzwischen eines gesetzt ("conflict"), wechselt die Anmeldeschranke von selbst zur Anmeldung.
 *
 * Daneben „Aus einer Sicherung wiederherstellen" (Umzug, Plattenausfall; docs/plan-einrichtung-b.md,
 * 2): Sicherungsdatei und Schlüssel wählen, die Vorschau ansehen, das Passwort aus der Sicherung
 * eingeben; Stowly startet neu, und dieses Gerät ist danach angemeldet (`RestoreFlow`).
 */
export function FirstRunPage({ onFirstRun, onBusy }: FirstRunPageProps) {
  const core = useCore();
  const toast = useToast();
  /** Die gewählte Sicherung: Mit ihr beginnt das Wiederherstellen gleich beim Hochladen. */
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  // Angemeldet (oder abgebrochen): Die Seite verschwindet, und mit ihr gilt nichts mehr als „läuft".
  useEffect(() => () => onBusy?.(false), [onBusy]);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [deviceName, setDeviceName] = useState(() => suggestDeviceName());
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const type = visible ? "text" : "password";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (Array.from(password).length < LIMITS.password_min) {
      setError(`Das Passwort braucht mindestens ${String(LIMITS.password_min)} Zeichen.`);
      return;
    }
    if (repeat !== password) {
      setError("Die beiden Passwörter sind verschieden.");
      return;
    }
    if (deviceName.trim() === "") {
      setError("Bitte diesem Gerät einen Namen geben.");
      return;
    }
    setBusy(true);
    setError(null);
    onFirstRun?.();
    try {
      await core.session.createPassword(password, deviceName.trim());
      // Angemeldet: Die Schranke zeigt jetzt die Einrichtung.
    } catch (caught) {
      setBusy(false);
      if (isCoreError(caught, "conflict")) {
        // Jemand war schneller; die Schranke zeigt gleich die Anmeldung.
        toast.show({ message: "Inzwischen ist ein Passwort festgelegt. Bitte damit anmelden.", tone: "warn" });
        return;
      }
      setError(firstRunErrorText(caught));
    }
  }

  if (restoreFile !== null) {
    return (
      <main className={styles.page}>
        <div className={styles.column}>
          <Logo size="lg" className={styles.logo} />
          <h1 className={styles.title}>Aus einer Sicherung wiederherstellen</h1>
          <RestoreFlow mode="first_run" initialFile={restoreFile} onCancel={() => setRestoreFile(null)} onFirstRun={onFirstRun} onBusyChange={onBusy} />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <Logo size="lg" className={styles.logo} />
        <Card padding="lg">
          <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
            <div className={styles.intro}>
              <h1 className={styles.title}>Willkommen bei Stowly</h1>
              <p className={styles.muted}>Zuerst das Passwort für den Haushalt festlegen. Damit melden sich alle Geräte an.</p>
            </div>
            <TextField
              label="Haushalts-Passwort"
              hint={`Mindestens ${String(LIMITS.password_min)} Zeichen.`}
              type={type}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              trailing={
                <IconButton label={visible ? "Passwort verbergen" : "Passwort anzeigen"} size="sm" aria-pressed={visible} onClick={() => setVisible(!visible)}>
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
              }
            />
            <TextField
              label="Passwort wiederholen"
              type={type}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
            <TextField
              label="Name dieses Geräts"
              hint="Zum Beispiel „Handy Küche“. Unter diesem Namen lässt sich das Gerät später einzeln abmelden."
              autoComplete="off"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
            />
            {error ? (
              <Notice tone="danger" role="alert" icon={<WarningIcon />}>
                {error}
              </Notice>
            ) : null}
            <Button type="submit" variant="primary" size="lg" block busy={busy}>
              Passwort festlegen
            </Button>
          </form>
        </Card>
        <Card padding="lg">
          <div className={styles.form}>
            <div className={styles.intro}>
              <h2 className={setupStyles.subtitle}>Aus einer Sicherung wiederherstellen</h2>
              <p className={styles.muted}>
                Umzug oder neues NAS? Mit einer Sicherung und ihrem geheimen Schlüssel kommt der ganze Bestand zurück, samt Passwort und Geräten.
              </p>
            </div>
            <FilePicker icon={<RestoreIcon />} block onFile={setRestoreFile}>
              Sicherung wählen
            </FilePicker>
          </div>
        </Card>
        <p className={styles.foot}>
          <InfoIcon size={15} aria-hidden="true" />
          Danach führt Stowly durch die Einrichtung: sichere Verbindung, Drucker, Sicherung, Updates, Benachrichtigungen und Home Assistant. Jeder Schritt lässt sich überspringen.
        </p>
      </div>
    </main>
  );
}
