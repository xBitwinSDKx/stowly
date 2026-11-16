import { useState, type FormEvent } from "react";

import { isCoreError, LIMITS, useCore } from "@/contract";
import { suggestDeviceName, waitText } from "@/features/auth";
import styles from "@/features/auth/LoginPage.module.css";
import { errorText, Logo, Notice } from "@/ui";
import { Button, Card, IconButton, TextField, useToast } from "@/ui/base";
import { EyeIcon, EyeOffIcon, InfoIcon, WarningIcon } from "@/ui/icons";

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
}

/**
 * „Willkommen bei Stowly": Der Server hat noch kein Haushalts-Passwort (`server_configured ===
 * false`). Wer die Seite zuerst öffnet, legt es fest, und dieses Gerät ist damit angemeldet.
 * Ist inzwischen eines gesetzt ("conflict"), wechselt die Anmeldeschranke von selbst zur Anmeldung.
 */
export function FirstRunPage({ onFirstRun }: FirstRunPageProps) {
  const core = useCore();
  const toast = useToast();
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
        <p className={styles.foot}>
          <InfoIcon size={15} aria-hidden="true" />
          Danach führt Stowly durch die Einrichtung: sichere Verbindung, Drucker, Updates und Benachrichtigungen. Jeder Schritt lässt sich überspringen.
        </p>
      </div>
    </main>
  );
}
