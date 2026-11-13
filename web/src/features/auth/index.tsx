import { useState, type FormEvent } from "react";

import { isCoreError, useCore, type SessionState } from "@/contract";
import { Button, Card, TextField } from "@/ui/base";

type SignedOutReason = Extract<SessionState, { status: "signed_out" }>["reason"];

const ERRORS: Record<string, string> = {
  invalid_password: "Das Passwort stimmt nicht.",
  rate_limited: "Zu viele Fehlversuche. Bitte kurz warten.",
  not_configured: "Auf dem Server ist kein Passwort gesetzt (STOWLY_PASSWORD).",
  protocol_mismatch: "App und Server passen nicht zusammen. Bitte beides aktualisieren.",
  offline: "Der Server ist nicht erreichbar.",
  invalid: "Bitte Passwort und Gerätenamen angeben.",
};

/** Anmeldung mit dem Haushalts-Passwort. Grundgerüst; Gestaltung folgt in Runde 1. */
export function LoginPage({ reason }: { reason: SignedOutReason }) {
  const core = useCore();
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await core.session.login(password, deviceName);
    } catch (caught) {
      setError(isCoreError(caught) ? (ERRORS[caught.code] ?? caught.message) : "Die Anmeldung ist fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ display: "grid", placeItems: "center", flex: 1, padding: "var(--space-4)" }}>
      <Card padding="lg" style={{ width: "min(100%, 24rem)" }}>
        <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: "var(--space-4)" }}>
          <h1>Stowly</h1>
          {reason === "revoked" ? (
            <p style={{ color: "var(--color-warn)" }}>Dieses Gerät wurde abgemeldet. Nach der Anmeldung werden offene Änderungen gesendet.</p>
          ) : null}
          <TextField
            label="Haushalts-Passwort"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <TextField
            label="Name dieses Geräts"
            hint="Zum Beispiel „Handy Küche“. Damit lässt sich das Gerät später einzeln abmelden."
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            maxLength={60}
            required
          />
          {error ? (
            <p role="alert" style={{ color: "var(--color-danger)" }}>
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block busy={busy}>
            Anmelden
          </Button>
        </form>
      </Card>
    </main>
  );
}
