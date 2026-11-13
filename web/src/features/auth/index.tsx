import { useEffect, useState, type FormEvent } from "react";

import { isCoreError, useCore, useLive, type SessionState } from "@/contract";
import { errorText, Logo, Notice } from "@/ui";
import { Button, Card, IconButton, TextField } from "@/ui/base";
import { CircleCheckIcon, EyeIcon, EyeOffIcon, InfoIcon, LockOpenIcon, RefreshIcon, WarningIcon } from "@/ui/icons";

import styles from "./LoginPage.module.css";

type SignedOutReason = Extract<SessionState, { status: "signed_out" }>["reason"];

/** Neutraler Vorschlag für den Gerätenamen, nach Bedienung und Bildschirmgröße. */
export function suggestDeviceName(): string {
  if (typeof matchMedia !== "function" || !matchMedia("(pointer: coarse)").matches) {
    return "Rechner";
  }
  return matchMedia("(min-width: 48rem)").matches ? "Tablet" : "Handy";
}

/** Wartezeit in Worten: „42 Sekunden", „1 Minute", „3 Minuten". */
export function waitText(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) {
    return whole === 1 ? "1 Sekunde" : `${String(whole)} Sekunden`;
  }
  const minutes = Math.ceil(whole / 60);
  return minutes === 1 ? "1 Minute" : `${String(minutes)} Minuten`;
}

/** Der Satz zu einem Fehler der Anmeldung. */
export function loginErrorText(error: unknown): string {
  return errorText(error, {
    invalid_password: "Das Passwort stimmt nicht.",
    not_configured: "Auf dem Server ist noch kein Haushalts-Passwort gesetzt. Es wird beim Einrichten des Servers festgelegt (STOWLY_PASSWORD).",
    offline: "Der Server ist nicht erreichbar. Zum Anmelden braucht es eine Verbindung zum Server.",
    protocol_mismatch: "Diese Version der App passt nicht zum Server. Bitte die Seite neu laden; hilft das nicht, muss der Server aktualisiert werden.",
    // Nur der Rückfall: Sagt der Kern genau, was nicht stimmt, steht sein Satz da.
    invalid: "Bitte das Passwort und einen Namen für dieses Gerät angeben.",
    internal: "Die Anmeldung ist fehlgeschlagen. Bitte noch einmal versuchen.",
  });
}

/** Sekunden bis `until` (Zeitstempel in Millisekunden), sekündlich aktualisiert; 0, wenn vorbei. */
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

export interface LoginPageProps {
  reason: SignedOutReason;
  /**
   * Der Name, unter dem dieses Gerät zuletzt angemeldet war (`SessionState.last_device_name`).
   * Er wird vorgeschlagen, damit das Gerät nach einer Sperre nicht unter einem zweiten Namen
   * in der Geräteliste steht.
   */
  lastDeviceName?: string | null;
}

/** Anmeldung mit dem Haushalts-Passwort und einem Namen für dieses Gerät. */
export function LoginPage({ reason, lastDeviceName = null }: LoginPageProps) {
  const core = useCore();
  const app = useLive(core.app.state);
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(() => (lastDeviceName && lastDeviceName.trim() !== "" ? lastDeviceName : suggestDeviceName()));
  const [updating, setUpdating] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bis wann der Server nach zu vielen Fehlversuchen keine Anmeldung annimmt. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const wait = useCountdown(lockedUntil);
  const locked = wait > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password === "") {
      setError("Bitte das Haushalts-Passwort eingeben.");
      return;
    }
    if (deviceName.trim() === "") {
      setError("Bitte diesem Gerät einen Namen geben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await core.session.login(password, deviceName.trim());
      // Angemeldet: Die Anmelde-Schranke zeigt jetzt die App.
    } catch (caught) {
      if (isCoreError(caught, "rate_limited")) {
        const seconds = Number(caught.details.retry_after_s);
        setLockedUntil(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
        setError(null);
      } else {
        setError(loginErrorText(caught));
      }
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <Logo size="lg" className={styles.logo} />

        {reason === "revoked" ? (
          <Notice tone="warn" icon={<WarningIcon />} title="Dieses Gerät wurde abgemeldet">
            Die Daten auf diesem Gerät sind noch da. Nach der Anmeldung werden Änderungen, die noch nicht gesendet waren, nachgereicht.
          </Notice>
        ) : null}
        {reason === "logout" ? (
          <Notice tone="success" icon={<CircleCheckIcon />} title="Abgemeldet">
            Die lokale Kopie der Daten wurde von diesem Gerät gelöscht.
          </Notice>
        ) : null}
        {app?.update_ready && !app.update_required ? (
          <Notice
            tone="accent"
            role="status"
            icon={<RefreshIcon />}
            title="Neue Version"
            action={
              <Button
                size="sm"
                variant="primary"
                busy={updating}
                onClick={() => {
                  setUpdating(true);
                  void core.app.applyUpdate().finally(() => setUpdating(false));
                }}
              >
                Jetzt aktualisieren
              </Button>
            }
          >
            Eine neue Version von Stowly ist geladen und wartet auf den Neustart.
          </Notice>
        ) : null}

        <Card padding="lg">
          <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
            <div className={styles.intro}>
              <h1 className={styles.title}>Anmelden</h1>
              <p className={styles.muted}>Mit dem Passwort des Haushalts. Dieses Gerät bleibt danach angemeldet.</p>
            </div>
            <TextField
              label="Haushalts-Passwort"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              trailing={
                <IconButton label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"} size="sm" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
              }
            />
            <TextField
              label="Name dieses Geräts"
              hint="Zum Beispiel „Handy Küche“. Unter diesem Namen lässt sich das Gerät später einzeln abmelden."
              autoComplete="off"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
            />
            {locked ? (
              <Notice tone="warn" role="alert" icon={<WarningIcon />} title="Zu viele Fehlversuche">
                Der Server nimmt gerade keine Anmeldung an. Nächster Versuch in {waitText(wait)}.
              </Notice>
            ) : error ? (
              <Notice tone="danger" role="alert" icon={<WarningIcon />}>
                {error}
              </Notice>
            ) : null}
            <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={locked}>
              Anmelden
            </Button>
          </form>
        </Card>

        {app?.secure_context === false ? (
          <Notice tone="neutral" icon={<LockOpenIcon />} title="Kein Scannen über diese Adresse">
            Scannen und Offline-Betrieb brauchen die HTTPS-Adresse von Stowly. Über eine http-Adresse läuft die App nur online und ohne Kamera.
          </Notice>
        ) : (
          <p className={styles.foot}>
            <InfoIcon size={15} aria-hidden="true" />
            Der Bestand wird auf dieses Gerät kopiert und funktioniert danach auch ohne Netz.
          </p>
        )}
      </div>
    </main>
  );
}
