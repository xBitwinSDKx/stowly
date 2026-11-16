import { useEffect, useState, type FormEvent } from "react";

import { useCore, type ServerConfig } from "@/contract";
import { errorText } from "@/ui";
import { Button, TextField, useToast } from "@/ui/base";

import styles from "./SettingsPage.module.css";

/** Der Kontakt zum Zeigen und Bearbeiten: ohne `mailto:` davor. */
export function contactText(contact: string | null | undefined): string {
  return contact?.replace(/^mailto:/, "") ?? "";
}

export interface PushContactFormProps {
  /** Die Einstellungen des Servers, wie zuletzt geladen. */
  config: ServerConfig;
  /** Der Server hat den Kontakt gespeichert: seine Antwort. */
  onSaved: (config: ServerConfig) => void;
}

/**
 * Der Kontakt für die Push-Dienste (`ServerConfig.push`, docs/integrationen.md 12): ein Feld mit
 * „Speichern". Kommt er aus der Umgebung (STOWLY_PUSH_CONTACT), steht er nur da.
 */
export function PushContactForm({ config, onSaved }: PushContactFormProps) {
  const core = useCore();
  const toast = useToast();
  const saved = contactText(config.push.contact);
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ein anderer Wert vom Server (neu geladen): Feld nachziehen.
  useEffect(() => {
    setText(saved);
    setError(null);
  }, [saved]);

  if (config.push.source === "env") {
    return (
      <p className={styles.fixed}>
        <span className={styles.key}>{saved}</span>
        <span className={styles.muted}>Kommt aus der Umgebung (STOWLY_PUSH_CONTACT) und ist nur dort änderbar.</span>
      </p>
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await core.serverConfig.update({ push_contact: text }));
      toast.show({ message: "Kontakt-Adresse gespeichert.", tone: "success" });
    } catch (caught) {
      setError(errorText(caught, { offline: "Zum Speichern braucht es den Server, und der ist gerade nicht erreichbar." }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.contact} onSubmit={(event) => void save(event)} noValidate>
      <TextField
        className={styles.contactField}
        label="Kontakt-Adresse (E-Mail)"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="haushalt@example.org"
        value={text}
        onChange={(event) => setText(event.target.value)}
        error={error}
      />
      <Button type="submit" busy={busy} disabled={text.trim() === saved && saved !== ""}>
        Speichern
      </Button>
    </form>
  );
}
