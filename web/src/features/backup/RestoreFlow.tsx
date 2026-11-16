import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { formatTimestamp, isCoreError, LIMITS, RESTORE_MAX_BYTES, useCore, type RestorePreview, type RestoreStatus, type RestoreUpload, type UploadProgress } from "@/contract";
import { suggestDeviceName } from "@/features/auth";
import { ConfirmDialog, formatBytes, Notice } from "@/ui";
import { Button, IconButton, Spinner, TextField } from "@/ui/base";
import { EyeIcon, EyeOffIcon, KeyIcon, LockOpenIcon, RestoreIcon, WarningIcon } from "@/ui/icons";

import styles from "./Backup.module.css";
import { FilePicker, readText, reloadPage } from "./files";
import { insecureNetwork, previewRows, restoreErrorText, uploadPercent } from "./texts";

export interface RestoreFlowProps {
  /** "running": ein laufender Stowly (angemeldet); "first_run": die Willkommensseite, noch ohne Passwort. */
  mode: "running" | "first_run";
  /** Zurück, ohne etwas einzuspielen. */
  onCancel: () => void;
  /** Erster Start: gleich vor dem Anwenden, wie vor dem ersten Passwort (die App wechselt zur Einrichtung). */
  onFirstRun?: () => void;
  /** Laufender Stowly: Stowly läuft nach dem Neustart wieder. Vorgabe: die Seite neu laden. */
  onRestarted?: (status: RestoreStatus) => void;
  /** Ob gerade hochgeladen, geprüft oder eingespielt wird (ein Dialog darum lässt sich dann nicht schließen). */
  onBusyChange?: (busy: boolean) => void;
  /** false: ohne eigenen Rahmen, etwa in einem Dialog. Vorgabe true. */
  framed?: boolean;
  /** Schon gewählt (Willkommensseite): Das Hochladen beginnt gleich. */
  initialFile?: File;
}

type Step = "file" | "uploading" | "key" | "checking" | "preview" | "restarting";

/** Die Überschrift je Schritt; sie bekommt den Fokus, wenn der Schritt wechselt. */
const TITLES: Record<Step, string> = {
  file: "Sicherungsdatei wählen",
  uploading: "Wird hochgeladen …",
  key: "Schlüssel eingeben",
  checking: "Wird geprüft …",
  preview: "Was in der Sicherung steckt",
  restarting: "Stowly startet neu …",
};

/**
 * Eine Sicherung zurückspielen (docs/plan-einrichtung-b.md, 2), in Schritten: Datei wählen und
 * hochladen (mit Fortschritt), bei einer verschlüsselten den geheimen Schlüssel einfügen oder die
 * Schlüsseldatei wählen, die Vorschau ansehen, dann einspielen.
 *
 * - Laufender Stowly: mit dem jetzigen Passwort und einer deutlichen Rückfrage; danach wartet die
 *   Ansicht auf den Neustart und lädt die Seite neu.
 * - Erster Start: mit dem Passwort aus der Sicherung (oder einem neuen, wenn sie keins hat) und dem
 *   Namen dieses Geräts; der Kern meldet nach dem Neustart an.
 *
 * Der geheime Schlüssel lebt nur bis zur Prüfung im Zustand dieser Ansicht. Über http weist sie
 * darauf hin, dass er dann unverschlüsselt durchs Heimnetz geht.
 */
export function RestoreFlow({ mode, onCancel, onFirstRun, onRestarted, onBusyChange, framed = true, initialFile }: RestoreFlowProps) {
  const core = useCore();
  const firstRun = mode === "first_run";
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>("file");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [upload, setUpload] = useState<RestoreUpload | null>(null);
  const [identity, setIdentity] = useState("");
  const [keyFile, setKeyFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [visible, setVisible] = useState(false);
  const [deviceName, setDeviceName] = useState(() => suggestDeviceName());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);
  const started = useRef(false);

  const busy = step === "uploading" || step === "checking" || step === "restarting";
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // Ein neuer Schritt: Fokus auf seine Überschrift (nicht beim ersten Zeichnen).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  // Eine schon gewählte Datei: gleich hochladen, einmal.
  useEffect(() => {
    if (initialFile && !started.current) {
      started.current = true;
      void sendFile(initialFile);
    }
    // Nur beim ersten Zeichnen; `sendFile` liest den Zustand dieses Zeichnens.
  }, []);

  function startOver(message: string | null) {
    setStep("file");
    setUpload(null);
    setPreview(null);
    setProgress(null);
    setIdentity("");
    setKeyFile(null);
    setError(message);
  }

  async function sendFile(chosen: File) {
    setFile(chosen);
    setError(null);
    if (chosen.size > RESTORE_MAX_BYTES) {
      setError(`Die Datei ist zu groß: Eine Sicherung darf höchstens ${String(RESTORE_MAX_BYTES / 1024 / 1024)} MiB haben.`);
      return;
    }
    setStep("uploading");
    setProgress({ loaded: 0, total: chosen.size });
    try {
      const uploaded = await core.restore.upload(chosen, { onProgress: setProgress });
      setUpload(uploaded);
      if (uploaded.kind === "age") {
        setStep("key");
      } else {
        // Unverschlüsselt (eine ältere Sicherung): gleich prüfen, ohne Schlüssel.
        await check(uploaded, null);
      }
    } catch (caught) {
      startOver(restoreErrorText(caught, firstRun));
    }
  }

  async function check(uploaded: RestoreUpload, secret: string | null) {
    setStep("checking");
    setError(null);
    try {
      setPreview(await core.restore.check(uploaded.upload_id, secret));
      setStep("preview");
    } catch (caught) {
      const text = restoreErrorText(caught, firstRun);
      if (uploaded.kind === "age" && !isCoreError(caught, "not_found")) {
        setStep("key");
        setError(text);
      } else {
        startOver(text);
      }
    } finally {
      // Der geheime Schlüssel bleibt nicht im Zustand der Seite.
      setIdentity("");
      setKeyFile(null);
    }
  }

  async function chooseKeyFile(chosen: File) {
    const text = await readText(chosen, LIMITS.restore_identity);
    if (text === null) {
      setError("Das ist keine Schlüsseldatei: Sie ist viel zu groß.");
      return;
    }
    setError(null);
    setIdentity("");
    setKeyFile({ name: chosen.name, text });
  }

  function submitKey(event: FormEvent) {
    event.preventDefault();
    const secret = keyFile?.text ?? identity;
    if (upload === null || secret.trim() === "") {
      setError("Bitte den geheimen Schlüssel einfügen oder die Schlüsseldatei wählen.");
      return;
    }
    void check(upload, secret);
  }

  /** Laufender Stowly, nach der Rückfrage: einspielen, auf den Neustart warten, neu laden. */
  async function applyRunning() {
    if (preview === null) {
      return;
    }
    await core.restore.apply({ restore_id: preview.restore_id, password });
    setConfirming(false);
    setPassword("");
    setStep("restarting");
    try {
      const status = await core.restore.waitForRestart();
      if (status.state === "failed") {
        startOver(status.message ?? "Das Zurückspielen ist gescheitert; die bisherige Datenbank läuft weiter.");
        return;
      }
      (onRestarted ?? (() => reloadPage()))(status);
    } catch (caught) {
      setError(restoreErrorText(caught, firstRun));
    }
  }

  /** Erster Start: einspielen; der Kern wartet auf den Neustart und meldet dieses Gerät an. */
  async function applyFirstRun(event: FormEvent) {
    event.preventDefault();
    if (preview === null) {
      return;
    }
    if (preview.has_password ? password === "" : Array.from(password).length < LIMITS.password_min) {
      setError(preview.has_password ? "Bitte das Passwort aus der Sicherung eingeben." : `Das Passwort braucht mindestens ${String(LIMITS.password_min)} Zeichen.`);
      return;
    }
    if (!preview.has_password && repeat !== password) {
      setError("Die beiden Passwörter sind verschieden.");
      return;
    }
    if (deviceName.trim() === "") {
      setError("Bitte diesem Gerät einen Namen geben.");
      return;
    }
    setError(null);
    setStep("restarting");
    // Gleich melden, nicht erst nach dem Zeichnen: Meldet der Server schon ein Passwort, bevor dieses
    // Gerät angemeldet ist, soll die Anmeldeschranke diese Seite stehen lassen.
    onBusyChange?.(true);
    onFirstRun?.();
    try {
      await core.restore.apply({ restore_id: preview.restore_id, password, device_name: deviceName.trim() });
      // Angemeldet: Die Anmeldeschranke zeigt jetzt die App.
    } catch (caught) {
      setStep("preview");
      setError(restoreErrorText(caught, true));
    }
  }

  function submitRunning(event: FormEvent) {
    event.preventDefault();
    if (password === "") {
      setError("Bitte das jetzige Haushalts-Passwort eingeben.");
      return;
    }
    setError(null);
    setConfirming(true);
  }

  const percent = uploadPercent(progress);
  const type = visible ? "text" : "password";
  const eye = (
    <IconButton label={visible ? "Passwort verbergen" : "Passwort anzeigen"} size="sm" aria-pressed={visible} onClick={() => setVisible(!visible)}>
      {visible ? <EyeOffIcon /> : <EyeIcon />}
    </IconButton>
  );

  return (
    <section className={framed ? styles.panel : styles.stack} aria-labelledby={titleId} aria-busy={busy}>
      <h3 id={titleId} ref={heading} tabIndex={-1} className={styles.panelTitle}>
        {TITLES[step]}
      </h3>

      {step === "file" ? (
        <>
          <p className={styles.muted}>
            {firstRun
              ? "Die Sicherung vom bisherigen Stowly, etwa stowly-2026-11-16-0330.sqlite3.gz.age. Dazu gehört der geheime Schlüssel, der beim Einrichten der Sicherung gesichert wurde."
              : "Eine Sicherung von Stowly, etwa aus dem Ordner der Sicherungen. Der Bestand aus ihr ersetzt den jetzigen; Geräte, Passwort und Einstellungen bleiben."}
          </p>
          <div className={styles.actions}>
            <FilePicker variant="primary" icon={<RestoreIcon />} onFile={(chosen) => void sendFile(chosen)}>
              Datei wählen
            </FilePicker>
            <Button variant="ghost" onClick={onCancel}>
              Abbrechen
            </Button>
          </div>
        </>
      ) : null}

      {step === "uploading" ? (
        <div className={styles.progress}>
          <span className={styles.small}>{file ? `${file.name} · ${formatBytes(file.size)}` : ""}</span>
          <div className={styles.progressBar} role="progressbar" aria-label="Hochladen" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${String(percent)} %`}>
            <div className={styles.progressFill} style={{ width: `${String(percent)}%` }} />
          </div>
          <span className={styles.small} aria-hidden="true">
            {percent} %
          </span>
        </div>
      ) : null}

      {step === "key" ? (
        <form className={styles.stack} onSubmit={submitKey} noValidate>
          <p className={styles.muted}>Die Sicherung ist verschlüsselt. Zum Öffnen braucht es den geheimen Schlüssel: einfügen oder die Schlüsseldatei wählen.</p>
          {insecureNetwork(window.location) ? (
            <Notice tone="warn" icon={<LockOpenIcon />} title="Unverschlüsselte Verbindung">
              Diese Seite läuft über http: Der geheime Schlüssel ginge unverschlüsselt durchs Heimnetz. Sicherer ist es über die HTTPS-Adresse von Stowly.
            </Notice>
          ) : null}
          {keyFile ? (
            <p className={styles.small}>
              Schlüsseldatei: <span className={styles.mono}>{keyFile.name}</span>
            </p>
          ) : (
            <TextField
              label="Geheimer Schlüssel"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="AGE-SECRET-KEY-1…"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              autoFocus
            />
          )}
          <div className={styles.actions}>
            <FilePicker variant="ghost" icon={<KeyIcon />} onFile={(chosen) => void chooseKeyFile(chosen)}>
              Schlüsseldatei wählen
            </FilePicker>
            {keyFile ? (
              <Button variant="ghost" onClick={() => setKeyFile(null)}>
                Doch einfügen
              </Button>
            ) : null}
          </div>
          {error ? (
            <Notice tone="danger" role="alert" icon={<WarningIcon />}>
              {error}
            </Notice>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" variant="primary">
              Prüfen
            </Button>
            <Button variant="ghost" onClick={() => startOver(null)}>
              Andere Datei
            </Button>
          </div>
        </form>
      ) : null}

      {step === "checking" ? (
        <p className={styles.actions}>
          <Spinner size={18} />
          <span>Stowly entschlüsselt und prüft die Sicherung. Bei großen Beständen dauert das eine Weile.</span>
        </p>
      ) : null}

      {step === "preview" && preview ? (
        <>
          <dl className={styles.preview}>
            {previewRows(preview).map((row) => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </Fragment>
            ))}
          </dl>
          {firstRun ? (
            <form className={styles.stack} onSubmit={(event) => void applyFirstRun(event)} noValidate>
              {preview.has_password ? (
                <TextField
                  label="Passwort aus der Sicherung"
                  hint="Das Haushalts-Passwort, das beim bisherigen Stowly galt."
                  type={type}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  trailing={eye}
                />
              ) : (
                <>
                  <TextField
                    label="Neues Haushalts-Passwort"
                    hint={`Die Sicherung enthält keins. Mindestens ${String(LIMITS.password_min)} Zeichen; die Geräte aus der Sicherung melden sich damit neu an.`}
                    type={type}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    trailing={eye}
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
                </>
              )}
              <TextField
                label="Name dieses Geräts"
                hint="Unter diesem Namen lässt sich das Gerät später einzeln abmelden."
                autoComplete="off"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
              />
              {error ? (
                <Notice tone="danger" role="alert" icon={<WarningIcon />}>
                  {error}
                </Notice>
              ) : null}
              <div className={styles.actions}>
                <Button type="submit" variant="primary" icon={<RestoreIcon />}>
                  Wiederherstellen
                </Button>
                <Button variant="ghost" onClick={() => startOver(null)}>
                  Andere Datei
                </Button>
              </div>
            </form>
          ) : (
            <form className={styles.stack} onSubmit={submitRunning} noValidate>
              <TextField
                label="Jetziges Haushalts-Passwort"
                hint="Zur Sicherheit: Zurückspielen ersetzt den ganzen Bestand."
                type={type}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                trailing={eye}
              />
              {error ? (
                <Notice tone="danger" role="alert" icon={<WarningIcon />}>
                  {error}
                </Notice>
              ) : null}
              <div className={styles.actions}>
                <Button type="submit" variant="danger" icon={<RestoreIcon />}>
                  Zurückspielen …
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                  Abbrechen
                </Button>
              </div>
            </form>
          )}
        </>
      ) : null}

      {step === "restarting" ? (
        <>
          <p className={styles.actions} role="status">
            <Spinner size={18} />
            <span>
              {firstRun
                ? "Stowly spielt die Sicherung ein und startet neu. Danach ist dieses Gerät angemeldet."
                : "Stowly spielt die Sicherung ein und startet neu. Das dauert meist unter einer Minute; danach lädt die Seite neu."}
            </span>
          </p>
          {error ? (
            <Notice tone="danger" role="alert" icon={<WarningIcon />}>
              {error}
            </Notice>
          ) : null}
        </>
      ) : null}

      {(step === "file" || step === "uploading") && error ? (
        <Notice tone="danger" role="alert" icon={<WarningIcon />}>
          {error}
        </Notice>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Sicherung jetzt einspielen?"
        confirmLabel="Einspielen"
        tone="danger"
        onConfirm={applyRunning}
        errorText={(caught) => restoreErrorText(caught, false)}
      >
        <p>
          Der Bestand aus der Sicherung{preview?.last_activity_at ? ` (Stand ${formatTimestamp(preview.last_activity_at)})` : ""} ersetzt alles, was jetzt in Stowly steht. Geräte,
          Passwort und Einstellungen bleiben.
        </p>
        <p>Stowly startet dafür neu, und alle Geräte laden den Bestand neu. Sieben Tage lang lässt es sich rückgängig machen.</p>
      </ConfirmDialog>
    </section>
  );
}
