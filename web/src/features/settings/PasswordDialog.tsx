import { useId, useState, type FormEvent } from "react";

import { LIMITS, useCore } from "@/contract";
import { errorText, focusFirstInvalid, Notice } from "@/ui";
import { Button, Dialog, dialogFocus, IconButton, TextField, useToast } from "@/ui/base";
import { EyeIcon, EyeOffIcon, WarningIcon } from "@/ui/icons";

import styles from "./SettingsPage.module.css";

/** Der Satz zu einem Fehler beim Ändern des Passworts. */
export function passwordErrorText(error: unknown): string {
  return errorText(error, {
    invalid_password: "Das bisherige Passwort stimmt nicht.",
    rate_limited: "Zu viele Fehlversuche. Bitte eine Minute warten und dann noch einmal versuchen.",
    offline: "Zum Ändern braucht es den Server, und der ist gerade nicht erreichbar.",
  });
}

/** Länge wie im Server gezählt (Unicode-Zeichen). */
function characters(text: string): number {
  return Array.from(text).length;
}

/**
 * Das Haushalts-Passwort ändern: bisheriges, neues und das neue noch einmal. Alle Geräte bleiben
 * angemeldet; das neue gilt für die Anmeldung weiterer Geräte. Ein falsches bisheriges Passwort
 * meldet dieses Gerät nicht ab.
 */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [visible, setVisible] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentError = tried && current === "" ? "Bitte das bisherige Passwort eingeben." : null;
  const nextError = tried && characters(next) < LIMITS.password_min ? `Das neue Passwort braucht mindestens ${String(LIMITS.password_min)} Zeichen.` : null;
  const repeatError = tried && nextError === null && repeat !== next ? "Die beiden Passwörter sind verschieden." : null;
  const type = visible ? "text" : "password";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (current === "" || characters(next) < LIMITS.password_min || repeat !== next) {
      focusFirstInvalid(formId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await core.session.changePassword(current, next);
      toast.show({ message: "Das Haushalts-Passwort ist geändert. Angemeldete Geräte bleiben angemeldet.", tone: "success" });
      onClose();
    } catch (caught) {
      setError(passwordErrorText(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Haushalts-Passwort ändern"
      size="sm"
      variant="sheet"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            Passwort ändern
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          ref={dialogFocus}
          label="Bisheriges Passwort"
          type={type}
          autoComplete="current-password"
          autoCapitalize="none"
          spellCheck={false}
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          error={currentError}
          trailing={
            <IconButton label={visible ? "Passwörter verbergen" : "Passwörter anzeigen"} size="sm" aria-pressed={visible} onClick={() => setVisible(!visible)}>
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </IconButton>
          }
        />
        <TextField
          label="Neues Passwort"
          hint={`Mindestens ${String(LIMITS.password_min)} Zeichen.`}
          type={type}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          value={next}
          onChange={(event) => setNext(event.target.value)}
          error={nextError}
        />
        <TextField
          label="Neues Passwort wiederholen"
          type={type}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          value={repeat}
          onChange={(event) => setRepeat(event.target.value)}
          error={repeatError}
        />
        {error ? (
          <Notice tone="danger" role="alert" icon={<WarningIcon />}>
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
