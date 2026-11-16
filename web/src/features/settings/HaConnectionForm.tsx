import { useEffect, useState, type FormEvent } from "react";

import { formatTimestamp, isCoreError, useCore, type HaCheck, type HaCheckInput, type HaConfig, type HaConfigChanges, type HaStatus } from "@/contract";
import { ConfirmDialog, errorText, List, ListRow, Notice, plural, Select, type NoticeTone } from "@/ui";
import { Button, TextField, useToast } from "@/ui/base";
import { CircleCheckIcon, PlugIcon, TrashIcon, WarningIcon } from "@/ui/icons";

import styles from "./SettingsPage.module.css";

const OFFLINE = "Dafür braucht es den Server, und der ist gerade nicht erreichbar.";
/** Wert der Auswahl für „von Hand eingeben". */
const MANUAL = "__hand__";

/** Die Adresse, wie der Server sie speichert: ohne Leerraum, Schema und Rechnername klein, ohne Schrägstrich am Ende. */
export function normalizeHaUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/^(https?:\/\/)(\[[^\]]*\]|[^/:?#]*)/i, (_match, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
}

/** Der Hinweis zum Ergebnis von „Verbindung prüfen" (`HaCheck.state`). */
export function checkTone(check: Pick<HaCheck, "state">): NoticeTone {
  return check.state === "ok" ? "success" : check.state === "token_needed" ? "info" : check.state === "unreachable" ? "warn" : "danger";
}

/** Eine Liste von HA in der Auswahl: „Einkaufsliste (4 offen)". */
export function listLabel(list: HaCheck["lists"][number]): string {
  return list.open === null ? list.name : `${list.name} (${String(list.open)} offen)`;
}

/** Was vor einem Wechsel der Liste gesagt wird, wenn Einträge gespiegelt sind (docs/plan-einrichtung-b.md, 3). */
export function switchListText(linked: number): string {
  return `Gerade ${linked === 1 ? "steht" : "stehen"} ${plural(linked, "Eintrag", "Einträge")} der Einkaufsliste in der bisherigen Liste. Sie bleiben dort stehen; Stowly hakt nichts ab und trägt seine offenen Einträge in die neue Liste ein.`;
}

export interface HaConnectionFormProps {
  config: HaConfig;
  /** Der Zustand des Abgleichs (gespiegelte Einträge, Zustand); null, solange er fehlt. */
  ha: HaStatus | null;
  /** Der Server hat gespeichert: seine Antwort. */
  onSaved: (config: HaConfig) => void;
  /** Nach dem Speichern: den Zustand neu laden. */
  onChanged: () => void;
}

/**
 * Die Verbindung zu Home Assistant (docs/plan-einrichtung-b.md, 3): Adresse, Token aus dem Profil
 * von HA (ein Passwortfeld, nie vorbefüllt; ein gespeicherter lässt sich ersetzen) und die
 * To-do-Liste. „Verbindung prüfen" holt die Listen von HA zur Auswahl; von Hand geht es auch.
 * Kommt die Verbindung aus der Umgebung, ist sie nur zu sehen und zu prüfen.
 */
export function HaConnectionForm({ config, ha, onSaved, onChanged }: HaConnectionFormProps) {
  const core = useCore();
  const toast = useToast();
  const env = config.source === "env";
  const [url, setUrl] = useState(config.url ?? "");
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [entity, setEntity] = useState(config.entity ?? "");
  const [manual, setManual] = useState(false);
  const [check, setCheck] = useState<HaCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<HaConfigChanges | null>(null);
  const [removing, setRemoving] = useState(false);

  // Neu geladen: Felder nachziehen; der Token bleibt leer.
  useEffect(() => {
    setUrl(config.url ?? "");
    setEntity(config.entity ?? "");
    setToken("");
    setReplacing(false);
  }, [config.url, config.entity, config.token_set_at]);

  const urlChanged = normalizeHaUrl(url) !== (config.url ?? "");
  const tokenField = !config.token_set || replacing || urlChanged;

  async function runCheck() {
    setChecking(true);
    setError(null);
    try {
      const input: HaCheckInput = env ? {} : { url, ...(token.trim() !== "" ? { token } : {}) };
      const result = await core.haConfig.check(input);
      setCheck(result);
      if (result.lists.length > 0 && entity === "") {
        // Gibt es nur eine Liste, ist sie es wohl.
        setEntity(result.lists.length === 1 ? (result.lists[0]?.entity_id ?? "") : "");
      }
    } catch (caught) {
      setCheck(null);
      setError(
        isCoreError(caught, "rate_limited")
          ? "Gerade erst geprüft. Bitte ein paar Sekunden warten."
          : errorText(caught, { offline: OFFLINE, not_supported: "Dieser Server kann Home Assistant noch nicht aus der App einrichten. Erst Stowly aktualisieren." }),
      );
    } finally {
      setChecking(false);
    }
  }

  async function save(changes: HaConfigChanges) {
    setSaving(true);
    setError(null);
    try {
      const saved = await core.haConfig.update(changes);
      setConfirm(null);
      onSaved(saved);
      onChanged();
      toast.show({ message: "Verbindung zu Home Assistant gespeichert.", tone: "success" });
    } catch (caught) {
      setConfirm(null);
      setError(errorText(caught, { offline: OFFLINE }));
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (normalizeHaUrl(url) === "") {
      setError("Bitte die Adresse von Home Assistant eingeben, etwa http://192.168.1.20:8123.");
      return;
    }
    if (tokenField && token.trim() === "") {
      setError(urlChanged && config.token_set ? "Für eine neue Adresse braucht es den Token noch einmal." : "Bitte den Zugangs-Token aus dem Profil von Home Assistant einfügen.");
      return;
    }
    if (entity.trim() === "") {
      setError("Bitte eine Liste wählen: erst „Verbindung prüfen“, oder von Hand eingeben.");
      return;
    }
    const changes: HaConfigChanges = { url: normalizeHaUrl(url), entity: entity.trim(), ...(token.trim() !== "" ? { token } : {}) };
    const linked = ha?.linked ?? 0;
    if (config.entity !== null && changes.entity !== config.entity && linked > 0) {
      setConfirm(changes);
      return;
    }
    void save(changes);
  }

  // Der Satz des Servers sagt alles: wie viele Listen, ob die eingestellte fehlt, was nicht ging.
  const checkResult = check ? (
    <Notice tone={checkTone(check)} icon={check.state === "ok" ? <CircleCheckIcon /> : <WarningIcon />} role="status">
      {check.message}
    </Notice>
  ) : null;

  if (env) {
    return (
      <div className={styles.push}>
        <List>
          <ListRow label="Adresse" inline>
            <code className={styles.value}>{config.url ?? "–"}</code>
          </ListRow>
          <ListRow label="Liste" inline>
            <code className={styles.value}>{config.entity ?? "–"}</code>
          </ListRow>
          <ListRow label="Token" hint={config.ca ? "Mit eigener Zertifizierungsstelle (STOWLY_HA_CA)." : undefined} inline>
            <span className={styles.value}>{config.token_set ? "gesetzt" : "fehlt"}</span>
          </ListRow>
        </List>
        <p className={styles.muted}>Kommt aus der Umgebung (STOWLY_HA_URL, STOWLY_HA_TOKEN, STOWLY_HA_TODO_ENTITY) und ist nur dort änderbar.</p>
        <div className={styles.pushActions}>
          <Button icon={<PlugIcon />} busy={checking} onClick={() => void runCheck()}>
            Verbindung prüfen
          </Button>
        </div>
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
        {checkResult}
        {check && check.lists.length > 0 ? (
          <ul className={styles.notes} aria-label="Listen in Home Assistant">
            {check.lists.map((list) => (
              <li key={list.entity_id}>
                {listLabel(list)} · <code>{list.entity_id}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const options = [
    { value: "", label: "Bitte wählen …" },
    ...(check?.lists ?? []).map((list) => ({ value: list.entity_id, label: listLabel(list) })),
    // Eine gespeicherte Liste, die die Prüfung (noch) nicht kennt, bleibt wählbar.
    ...(config.entity !== null && !(check?.lists ?? []).some((list) => list.entity_id === config.entity) ? [{ value: config.entity, label: config.entity }] : []),
    { value: MANUAL, label: "Von Hand eingeben …" },
  ];

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        label="Adresse von Home Assistant"
        hint="Wie Stowly HA im Heimnetz erreicht, etwa http://192.168.1.20:8123."
        inputMode="url"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="http://192.168.1.20:8123"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      {tokenField ? (
        <TextField
          label="Zugangs-Token"
          hint={
            urlChanged && config.token_set
              ? "Für eine neue Adresse braucht es den Token noch einmal: Er gilt nur für die Adresse, für die er eingetragen wurde."
              : "In HA: Profil → Sicherheit → Langlebige Zugangs-Token → Token erstellen. Am besten für einen eigenen Benutzer, der nur die Liste braucht."
          }
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      ) : (
        <List>
          <ListRow label="Zugangs-Token" hint={config.token_set_at ? `Gespeichert am ${formatTimestamp(config.token_set_at)}. Er steht in keiner Sicherung.` : undefined}>
            <Button size="sm" onClick={() => setReplacing(true)}>
              Ersetzen
            </Button>
          </ListRow>
        </List>
      )}
      <div className={styles.pushActions}>
        <Button icon={<PlugIcon />} busy={checking} disabled={normalizeHaUrl(url) === ""} onClick={() => void runCheck()}>
          Verbindung prüfen
        </Button>
      </div>
      {checkResult}
      {manual || (check === null && config.entity === null) ? (
        <TextField
          label="Liste in Home Assistant"
          hint="Die Kennung der To-do-Liste, etwa todo.einkaufsliste (Einstellungen → Entitäten)."
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="todo.einkaufsliste"
          value={entity}
          onChange={(event) => setEntity(event.target.value)}
        />
      ) : (
        <Select
          label="Liste in Home Assistant"
          hint="Die To-do-Liste, die mit Bring! verbunden ist."
          options={options}
          value={options.some((option) => option.value === entity) ? entity : ""}
          onChange={(value) => {
            if (value === MANUAL) {
              setManual(true);
            } else {
              setEntity(value);
            }
          }}
        />
      )}
      {error ? (
        <Notice tone="danger" role="alert" icon={<WarningIcon />}>
          {error}
        </Notice>
      ) : null}
      <div className={styles.pushActions}>
        <Button type="submit" variant="primary" busy={saving}>
          Speichern
        </Button>
        {config.source === "app" ? (
          <Button variant="ghost" icon={<TrashIcon />} disabled={saving} onClick={() => setRemoving(true)}>
            Verbindung entfernen
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Liste wechseln?"
        confirmLabel="Wechseln"
        onConfirm={() => (confirm === null ? undefined : save(confirm))}
        errorText={(caught) => errorText(caught, { offline: OFFLINE })}
      >
        <p>{switchListText(ha?.linked ?? 0)}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Verbindung entfernen?"
        confirmLabel="Entfernen"
        tone="danger"
        onConfirm={async () => {
          await save({ url: null, entity: null, token: null });
          setRemoving(false);
        }}
        errorText={(caught) => errorText(caught, { offline: OFFLINE })}
      >
        <p>Stowly vergisst Adresse, Token und Liste. Die Einkaufsliste in Stowly bleibt; in Bring! erscheint nichts Neues mehr.</p>
      </ConfirmDialog>
    </form>
  );
}
