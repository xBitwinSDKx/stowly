import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { formatTimestamp, LIMITS, useCore, type BackupConfig, type ServerConfig } from "@/contract";
import { Checkbox, ConfirmDialog, errorText, Notice } from "@/ui";
import { Badge, Button, IconButton, TextField, useToast } from "@/ui/base";
import { CopyField } from "@/ui/CopyField";
import { CircleCheckIcon, DownloadIcon, EyeIcon, EyeOffIcon, KeyIcon, PlusIcon, ShieldCheckIcon, TrashIcon, WarningIcon } from "@/ui/icons";

import styles from "./Backup.module.css";
import { FilePicker, readText, saveBlob } from "./files";
import type { AgeKeyPair, KeyCheckResult } from "./keys";
import { loadKeys } from "./load";
import { envText, keyErrorText, SAVE_OFFLINE } from "./texts";

const LOAD_FAILED = "Der Teil für Schlüssel ließ sich nicht laden. Bitte die Seite neu laden.";
const PASSWORD_MISSING = "Bitte das Haushalts-Passwort eingeben.";

/**
 * Das Haushalts-Passwort, bevor ein Schlüssel hinzukommt: Mit einem neuen Schlüssel lässt sich jede
 * künftige Sicherung öffnen, samt Passwort-Hash. Darum fragt Stowly danach, wie beim Zurückspielen;
 * entfernen geht ohne. Das Passwort geht nur mit dieser einen Anfrage an den Server.
 */
function HouseholdPassword({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: string | null }) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      label="Haushalts-Passwort"
      hint="Zur Sicherheit: Mit einem neuen Schlüssel lässt sich jede künftige Sicherung öffnen."
      type={visible ? "text" : "password"}
      autoComplete="current-password"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      trailing={
        <IconButton label={visible ? "Passwort verbergen" : "Passwort anzeigen"} size="sm" aria-pressed={visible} onClick={() => setVisible(!visible)}>
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </IconButton>
      }
    />
  );
}

/** Die öffentlichen Schlüssel aus der App, wie der Server sie kennt. */
function appKeys(config: BackupConfig): string[] {
  return config.recipients_source === "env" ? [] : config.recipients.map((recipient) => recipient.key);
}

export interface BackupKeysProps {
  config: BackupConfig;
  /** Der Server hat die Schlüssel gespeichert: seine Antwort. */
  onSaved: (config: ServerConfig) => void;
  /** Im Assistenten beginnt es ohne Schlüssel gleich mit „Schlüssel erzeugen". */
  variant?: "settings" | "wizard";
}

/**
 * Die Schlüssel der Sicherung (docs/plan-einrichtung-b.md, 1): die gespeicherten öffentlichen mit
 * „Entfernen", „Schlüssel erzeugen" (das Paar entsteht im Browser, der geheime Teil bleibt hier) und
 * „Öffentlichen Schlüssel hinzufügen" für einen, der schon anderswo liegt. Beides fragt nach dem
 * Haushalts-Passwort, denn ein neuer Schlüssel öffnet jede künftige Sicherung; Entfernen geht ohne.
 * Kommen die Schlüssel aus der Umgebung, sind sie nur zu sehen.
 */
export function BackupKeys({ config, onSaved, variant = "settings" }: BackupKeysProps) {
  const core = useCore();
  const toast = useToast();
  const fromEnv = config.recipients_source === "env";
  const empty = config.recipients.length === 0;
  const [mode, setMode] = useState<"idle" | "create" | "add">(variant === "wizard" && empty && !fromEnv ? "create" : "idle");
  const [removing, setRemoving] = useState<string | null>(null);
  const full = config.recipients.length >= LIMITS.backup_recipients;

  function done(saved: ServerConfig) {
    onSaved(saved);
    setMode("idle");
  }

  async function remove(key: string) {
    const next = appKeys(config).filter((candidate) => candidate !== key);
    onSaved(await core.serverConfig.update({ backup_recipients: next }));
    setRemoving(null);
    toast.show({ message: "Schlüssel entfernt.", tone: "success" });
  }

  return (
    <div className={styles.stack}>
      {empty ? (
        <p className={styles.muted}>Noch kein Schlüssel. Ohne ihn ruht die Sicherung: Stowly verschlüsselt jede Sicherung für die Schlüssel hier.</p>
      ) : (
        <ul className={styles.keyList} aria-label="Öffentliche Schlüssel">
          {config.recipients.map((recipient) => (
            <li key={recipient.key} className={styles.keyItem}>
              <span className={styles.keyText}>
                <Badge className={styles.mono} title={recipient.key}>
                  {recipient.short}
                </Badge>
                <span className={styles.small}>{recipient.added_at ? `hinzugefügt am ${formatTimestamp(recipient.added_at)}` : "aus der Umgebung"}</span>
              </span>
              {fromEnv ? null : (
                <Button size="sm" variant="ghost" icon={<TrashIcon />} aria-label={`Schlüssel ${recipient.short} entfernen`} onClick={() => setRemoving(recipient.key)}>
                  Entfernen
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {fromEnv ? (
        <p className={styles.small}>{envText("env", "STOWLY_BACKUP_RECIPIENTS")}</p>
      ) : mode === "create" ? (
        <KeyCreator existing={appKeys(config)} onSaved={done} onCancel={() => setMode("idle")} />
      ) : mode === "add" ? (
        <AddRecipient existing={appKeys(config)} onSaved={done} onCancel={() => setMode("idle")} />
      ) : (
        <div className={styles.actions}>
          <Button variant={empty ? "primary" : "secondary"} icon={<KeyIcon />} disabled={full} onClick={() => setMode("create")}>
            Schlüssel erzeugen
          </Button>
          <Button variant="ghost" icon={<PlusIcon />} disabled={full} onClick={() => setMode("add")}>
            Öffentlichen Schlüssel hinzufügen
          </Button>
          {full ? <span className={styles.small}>Höchstens {String(LIMITS.backup_recipients)} Schlüssel.</span> : null}
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Schlüssel entfernen?"
        confirmLabel="Entfernen"
        tone="danger"
        onConfirm={() => (removing === null ? undefined : remove(removing))}
        errorText={(caught) => errorText(caught, { offline: SAVE_OFFLINE })}
      >
        <p>Neue Sicherungen sind dann nicht mehr für diesen Schlüssel verschlüsselt. Ältere lassen sich weiter mit ihm öffnen.</p>
        {config.recipients.length === 1 ? <p>Es ist der letzte Schlüssel: Ohne ihn ruht die automatische Sicherung.</p> : null}
      </ConfirmDialog>
    </div>
  );
}

interface KeyFormProps {
  /** Die öffentlichen Schlüssel aus der App, die bleiben. */
  existing: string[];
  onSaved: (config: ServerConfig) => void;
  onCancel: () => void;
}

/**
 * „Schlüssel erzeugen": Das Paar entsteht im Browser (./keys.ts). Den geheimen Teil gibt es einmal
 * als Datei und zum Kopieren, mit dem Rat, ihn an zwei Orten aufzuheben. Erst nach „Ich habe ihn
 * gesichert" und mit dem Haushalts-Passwort geht der öffentliche an Stowly; der geheime lebt nur im
 * Zustand dieser Ansicht und ist danach weg. Ein falsches Passwort lässt das Paar stehen.
 */
export function KeyCreator({ existing, onSaved, onCancel }: KeyFormProps) {
  const core = useCore();
  const toast = useToast();
  const titleId = useId();
  const [pair, setPair] = useState<AgeKeyPair | null>(null);
  const [file, setFile] = useState<{ text: string; name: string } | null>(null);
  const [kept, setKept] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    loadKeys().then(
      (keys) => {
        if (!active) {
          return;
        }
        const created = keys.generateKeyPair();
        setPair(created);
        setFile({ text: keys.keyFile(created), name: keys.keyFileName() });
      },
      () => {
        if (active) {
          setError(LOAD_FAILED);
        }
      },
    );
    heading.current?.focus({ preventScroll: true });
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    if (pair === null || !kept) {
      return;
    }
    if (password === "") {
      setPasswordError(PASSWORD_MISSING);
      return;
    }
    setBusy(true);
    setError(null);
    setPasswordError(null);
    try {
      const saved = await core.serverConfig.update({ backup_recipients: [...existing, pair.public], current_password: password });
      // Der geheime Schlüssel ist gesichert; hier bleibt nichts von ihm und nichts vom Passwort.
      setPair(null);
      setFile(null);
      setPassword("");
      onSaved(saved);
      toast.show({ message: "Schlüssel übernommen: Die nächste Sicherung ist für ihn verschlüsselt.", tone: "success" });
    } catch (caught) {
      setError(keyErrorText(caught));
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1} className={styles.panelTitle}>
        Neuer Schlüssel
      </h3>
      {pair === null ? (
        error ? (
          <Notice tone="danger" role="alert" icon={<WarningIcon />}>
            {error}
          </Notice>
        ) : (
          <p className={styles.muted}>Wird erzeugt …</p>
        )
      ) : (
        <>
          <Notice tone="warn" icon={<KeyIcon />} title="Den geheimen Schlüssel jetzt sichern">
            Nur mit ihm lässt sich eine Sicherung zurückspielen. Stowly speichert ihn nicht und zeigt ihn nur jetzt. Am besten an zwei Orten aufheben, etwa auf einem USB-Stick
            und im Passwort-Manager.
          </Notice>
          <CopyField value={pair.secret} label="Geheimer Schlüssel" />
          <div className={styles.actions}>
            <Button icon={<DownloadIcon />} onClick={() => file && saveBlob(new Blob([file.text], { type: "text/plain" }), file.name)}>
              Als Datei speichern
            </Button>
          </div>
          <p className={styles.small}>
            Öffentlicher Schlüssel, der an Stowly geht: <span className={styles.mono}>{pair.public}</span>
          </p>
          <form
            className={styles.stack}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            noValidate
          >
            <Checkbox checked={kept} onChange={setKept}>
              Ich habe ihn gesichert.
            </Checkbox>
            <HouseholdPassword
              value={password}
              error={passwordError}
              onChange={(next) => {
                setPassword(next);
                setPasswordError(null);
              }}
            />
            {error ? (
              <Notice tone="danger" role="alert" icon={<WarningIcon />}>
                {error}
              </Notice>
            ) : null}
            <div className={styles.actions}>
              <Button type="submit" variant="primary" icon={<ShieldCheckIcon />} busy={busy} disabled={!kept}>
                Schlüssel übernehmen
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onCancel}>
                Abbrechen
              </Button>
            </div>
          </form>
        </>
      )}
      {pair === null && error ? (
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onCancel}>
            Schließen
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * „Öffentlichen Schlüssel hinzufügen": einer, der schon anderswo liegt (`age1…`), mit dem
 * Haushalts-Passwort. Ein geheimer wird nie gesendet.
 */
export function AddRecipient({ existing, onSaved, onCancel }: KeyFormProps) {
  const core = useCore();
  const toast = useToast();
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    setKeyError(null);
    setPasswordError(null);
    setError(null);
    let keys;
    try {
      keys = await loadKeys();
    } catch {
      setError(LOAD_FAILED);
      return;
    }
    if (keys.looksSecret(text)) {
      // Nie an den Server: das Feld leeren und sagen, warum.
      setText("");
      setKeyError("Das ist ein geheimer Schlüssel. Hierher gehört nur der öffentliche (age1…); den geheimen gut aufheben und nirgends eintragen.");
      return;
    }
    const key = keys.normalizePublic(text);
    if (key === null) {
      setKeyError("Das ist kein öffentlicher Schlüssel von age. Er beginnt mit age1 und hat 62 Zeichen.");
      return;
    }
    if (existing.includes(key)) {
      setKeyError("Diesen Schlüssel gibt es schon.");
      return;
    }
    if (password === "") {
      setPasswordError(PASSWORD_MISSING);
      return;
    }
    setBusy(true);
    try {
      onSaved(await core.serverConfig.update({ backup_recipients: [...existing, key], current_password: password }));
      setPassword("");
      toast.show({ message: "Schlüssel hinzugefügt.", tone: "success" });
    } catch (caught) {
      setError(keyErrorText(caught));
      setBusy(false);
    }
  }

  return (
    <form className={styles.stack} onSubmit={(event) => void add(event)} noValidate>
      <TextField
        label="Öffentlicher Schlüssel"
        hint="Beginnt mit age1, etwa aus age-keygen auf einem anderen Rechner."
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        error={keyError}
        autoFocus
      />
      <HouseholdPassword
        value={password}
        error={passwordError}
        onChange={(next) => {
          setPassword(next);
          setPasswordError(null);
        }}
      />
      {error ? (
        <Notice tone="danger" role="alert" icon={<WarningIcon />}>
          {error}
        </Notice>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" busy={busy} disabled={text.trim() === ""}>
          Hinzufügen
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}

/** Was „Schlüssel prüfen" ergibt, als Hinweis. */
function checkNotice(result: KeyCheckResult, recipients: BackupConfig["recipients"]) {
  if (result.kind === "match") {
    const short = recipients.find((recipient) => recipient.key === result.public)?.short ?? result.public;
    return (
      <Notice tone="success" role="status" icon={<CircleCheckIcon />} title="Der Schlüssel passt">
        Er gehört zu {short}: Mit ihm lassen sich die Sicherungen zurückspielen.
      </Notice>
    );
  }
  if (result.kind === "no_match") {
    return (
      <Notice tone="danger" role="alert" icon={<WarningIcon />} title="Der Schlüssel passt nicht">
        Er gehört zu keinem der gespeicherten öffentlichen Schlüssel. Sicherungen von jetzt lassen sich mit ihm nicht öffnen.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" role="alert" icon={<WarningIcon />} title="Kein geheimer Schlüssel">
      Ein geheimer Schlüssel von age beginnt mit AGE-SECRET-KEY-1. Auch die ganze Schlüsseldatei geht.
    </Notice>
  );
}

/**
 * „Schlüssel prüfen": den gesicherten geheimen Schlüssel einfügen oder die Schlüsseldatei wählen;
 * der Browser errechnet den öffentlichen und vergleicht ihn mit den gespeicherten. Nichts davon geht
 * an den Server, und das Feld ist danach wieder leer.
 */
export function KeyCheck({ recipients }: { recipients: BackupConfig["recipients"] }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<KeyCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(secret: string) {
    setError(null);
    try {
      const keys = await loadKeys();
      setResult(keys.checkSecret(secret, recipients.map((recipient) => recipient.key)));
    } catch {
      setError(LOAD_FAILED);
    } finally {
      setText("");
    }
  }

  async function pickFile(file: File) {
    const content = await readText(file, LIMITS.restore_identity);
    setFileName(file.name);
    if (content === null) {
      setResult({ kind: "invalid" });
      return;
    }
    await check(content);
  }

  return (
    <div className={styles.stack}>
      <form
        className={styles.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          setFileName(null);
          void check(text);
        }}
        noValidate
      >
        <TextField
          className={styles.inlineField}
          label="Geheimer Schlüssel"
          hint="Geprüft wird nur hier im Browser; der Schlüssel geht nirgends hin."
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="AGE-SECRET-KEY-1…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={text.trim() === ""}>
          Prüfen
        </Button>
      </form>
      <div className={styles.actions}>
        <FilePicker variant="ghost" icon={<KeyIcon />} onFile={(file) => void pickFile(file)}>
          Schlüsseldatei wählen
        </FilePicker>
        {fileName ? <span className={styles.small}>{fileName}</span> : null}
      </div>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : result ? (
        checkNotice(result, recipients)
      ) : null}
    </div>
  );
}
