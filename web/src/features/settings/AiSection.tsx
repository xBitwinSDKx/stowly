import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router";

import { formatTimestamp, isCoreError, useCore, type AiCheck, type AiConfig, type AiModel } from "@/contract";
import { checkAiKey } from "@/contract/ai";
import { AI_MODEL_OPTIONS, modelName } from "@/features/cook/texts";
import { ConfirmDialog, errorText, List, ListRow, Notice, Section, Select, type NoticeTone } from "@/ui";
import { Button, Spinner, TextField, useToast } from "@/ui/base";
import { CircleCheckIcon, ExternalLinkIcon, KeyIcon, PlugIcon, ShieldCheckIcon, TrashIcon, WarningIcon } from "@/ui/icons";

import type { LoadedResource } from "./loaded";
import styles from "./SettingsPage.module.css";

/** Was an Anthropic geht und was nicht (docs/plan-0.6.md, „Einstellungen"): immer sichtbar. */
export const AI_PRIVACY =
  "Fragst du nach Ideen, schickt der Stowly-Server an Anthropic (USA): Name, Marke, Packungsgröße und Anzahl jedes Produkts im Bestand (höchstens 300) mit den Tagen bis zum MHD, dazu deinen Wunsch und die gewählten Zutaten. Nicht dabei: Zonen, Barcodes, Bilder, Packungs-IDs, Geräte, Einkaufsliste. Es gelten die API-Bedingungen von Anthropic; die Kosten trägt das Konto des Schlüssels. Der Schlüssel liegt nur auf dem Server und in keiner Sicherung; nach dem Zurückspielen musst du ihn neu eintragen. Die Such-Links zu Cookidoo und Chefkoch brauchen keinen Schlüssel.";

/** Wo Schlüssel entstehen: ein fester Verweis, wie die zu Cookidoo und Chefkoch. */
export const ANTHROPIC_CONSOLE = "https://console.anthropic.com/";

const OFFLINE = "Dafür braucht es den Server, und der ist gerade nicht erreichbar.";

/** Die Sprungziele dieses Abschnitts: der Abschnitt selbst und der Hinweis zum Datenschutz. */
const ANCHORS: ReadonlySet<string> = new Set(["ki", "ki-datenschutz"]);

/** Der Ton des Ergebnisses von „Prüfen" (`AiCheck.state`). */
export function aiCheckTone(check: Pick<AiCheck, "state">): NoticeTone {
  return check.state === "ok" ? "success" : check.state === "busy" || check.state === "unreachable" ? "warn" : "danger";
}

/** Was eine Prüfung sagt, wenn sie gar nicht erst zustande kommt. */
function checkFailure(caught: unknown): string {
  if (isCoreError(caught, "rate_limited")) {
    return "Gerade erst geprüft. Bitte ein paar Sekunden warten.";
  }
  if (isCoreError(caught, "not_configured")) {
    return "Erst einen API-Schlüssel eintragen, dann lässt er sich prüfen.";
  }
  return errorText(caught, { offline: OFFLINE });
}

/** Die Wahl des Modells: die drei von Anthropic, dazu ein unbekanntes, das der Server meldet. */
function modelOptions(current: string): { value: AiModel; label: string }[] {
  const options = AI_MODEL_OPTIONS.map((option) => ({ value: option.value, label: `${option.name}: ${option.hint}` }));
  return options.some((option) => option.value === current) ? options : [...options, { value: current as AiModel, label: modelName(current) }];
}

interface AiFormProps {
  config: AiConfig;
  onSaved: (config: AiConfig) => void;
}

/**
 * Schlüssel, Prüfung, Modell und Tageszähler. Der Schlüssel steht in einem Passwortfeld, nie vorbefüllt;
 * gespeichert ist er nur „gesetzt", nie zu sehen. Kommt er aus der Umgebung, ist er hier gesperrt;
 * „Prüfen" und das Modell gehen trotzdem.
 */
function AiForm({ config, onSaved }: AiFormProps) {
  const core = useCore();
  const toast = useToast();
  const env = config.source === "env";
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<AiCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const keyField = !env && (!config.key_set || replacing);
  const typed = keyField && key.trim() !== "";

  async function save(event: FormEvent) {
    event.preventDefault();
    let clean: string;
    try {
      clean = checkAiKey(key);
    } catch (caught) {
      setKeyError(errorText(caught));
      return;
    }
    setSaving(true);
    setKeyError(null);
    try {
      const saved = await core.ai.update({ key: clean });
      setKey("");
      setReplacing(false);
      setCheck(null);
      onSaved(saved);
      toast.show({ message: "API-Schlüssel gespeichert. „Prüfen“ zeigt, ob Anthropic ihn annimmt.", tone: "success" });
    } catch (caught) {
      setKeyError(errorText(caught, { offline: OFFLINE }));
    } finally {
      setSaving(false);
    }
  }

  async function runCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      if (typed) {
        checkAiKey(key);
      }
      setCheck(await core.ai.check(typed ? { key } : {}));
    } catch (caught) {
      setCheck(null);
      setCheckError(checkFailure(caught));
    } finally {
      setChecking(false);
    }
  }

  async function changeModel(model: AiModel) {
    setModelSaving(true);
    try {
      onSaved(await core.ai.update({ model }));
      setCheck(null);
      toast.show({ id: "ai-model", message: `Modell gespeichert: ${modelName(model)}.`, tone: "success", duration: 2500 });
    } catch (caught) {
      toast.show({ message: errorText(caught, { offline: OFFLINE }), tone: "danger" });
    } finally {
      setModelSaving(false);
    }
  }

  const current = AI_MODEL_OPTIONS.find((option) => option.value === config.model);

  return (
    <div className={styles.push}>
      {config.problem ? (
        <Notice tone="warn" icon={<WarningIcon />} role="status">
          {config.problem}
        </Notice>
      ) : null}
      <List>
        <ListRow
          label="Vorschläge von Claude"
          hint={
            config.configured
              ? "Auf „Was koche ich?“ schlägt Claude auf Knopfdruck Gerichte aus dem Vorrat vor."
              : "Ohne API-Schlüssel gibt es auf „Was koche ich?“ nur die Such-Links zu Cookidoo und Chefkoch."
          }
          inline
        >
          <span className={styles.value}>{config.configured ? "eingerichtet" : "aus"}</span>
        </ListRow>
        {env ? (
          <ListRow label="API-Schlüssel" hint="Kommt aus der Umgebung (STOWLY_ANTHROPIC_API_KEY) und ist nur dort änderbar." inline>
            <span className={styles.value}>gesetzt</span>
          </ListRow>
        ) : keyField ? null : (
          <ListRow
            label="API-Schlüssel"
            hint={`${config.key_set_at ? `Gespeichert am ${formatTimestamp(config.key_set_at)}.` : "Gespeichert."} Er liegt nur auf dem Server und in keiner Sicherung.`}
          >
            <div className={styles.pushActions}>
              <Button size="sm" onClick={() => setReplacing(true)}>
                Ersetzen
              </Button>
              <Button size="sm" variant="ghost" icon={<TrashIcon />} onClick={() => setRemoving(true)}>
                Entfernen
              </Button>
            </div>
          </ListRow>
        )}
        <ListRow label="Modell" hint={current ? `${current.name}: ${current.hint}. Gilt ab der nächsten Anfrage.` : undefined} stacked>
          <Select<AiModel> label="Modell" hideLabel options={modelOptions(config.model)} value={config.model} disabled={modelSaving} onChange={(model) => void changeModel(model)} />
        </ListRow>
        <ListRow label="Heute" hint="Anfragen des ganzen Haushalts; um Mitternacht (Zeit des Servers) beginnt die Zählung neu." inline>
          <span className={styles.value}>
            {config.used_today} von {config.daily_limit}
          </span>
        </ListRow>
      </List>

      {keyField ? (
        <form className={styles.form} onSubmit={save} noValidate>
          <TextField
            label="API-Schlüssel von Anthropic"
            hint="Er liegt danach nur auf dem Server: in keiner Sicherung und in keiner Antwort an die App."
            type="password"
            placeholder="sk-ant-…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            error={keyError}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <div className={styles.pushActions}>
            <Button type="submit" variant="primary" icon={<KeyIcon />} busy={saving}>
              Speichern
            </Button>
            {replacing ? (
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setReplacing(false);
                  setKey("");
                  setKeyError(null);
                }}
              >
                Abbrechen
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      <div className={styles.pushActions}>
        <Button icon={<PlugIcon />} busy={checking} disabled={!config.key_set && !typed} onClick={() => void runCheck()}>
          Prüfen
        </Button>
        <span className={styles.pause}>{typed ? "prüft den eingegebenen Schlüssel; kostet keine Tokens" : "kostet keine Tokens"}</span>
      </div>
      {check ? (
        <Notice tone={aiCheckTone(check)} icon={check.state === "ok" ? <CircleCheckIcon /> : <WarningIcon />} role="status">
          {check.message}
        </Notice>
      ) : null}
      {checkError ? (
        <Notice tone="danger" role="alert">
          {checkError}
        </Notice>
      ) : null}

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="API-Schlüssel entfernen?"
        confirmLabel="Entfernen"
        tone="danger"
        onConfirm={async () => {
          onSaved(await core.ai.update({ key: null }));
          setRemoving(false);
          setCheck(null);
          toast.show({ message: "API-Schlüssel entfernt.", tone: "success" });
        }}
        errorText={(caught) => errorText(caught, { offline: OFFLINE })}
      >
        <p>Stowly vergisst den Schlüssel. Vorschläge von Claude gibt es erst wieder mit einem neuen; die Such-Links zu Cookidoo und Chefkoch bleiben.</p>
      </ConfirmDialog>
    </div>
  );
}

export interface AiSectionProps {
  /** Die Einrichtung vom Server (`core.ai.load`); die Einstellungen laden sie auch für die Zeile unter „Über". */
  config: LoadedResource<AiConfig>;
}

/**
 * „KI-Vorschläge" (seit 0.6.0; docs/plan-0.6.md, 3): API-Schlüssel von Anthropic, Prüfen, Modell,
 * Tageszähler und der Hinweis zum Datenschutz, der immer zu sehen ist. Nachgeladen: Das Formular
 * gehört nicht in den Teil der Einstellungen, den jeder Aufruf braucht.
 */
export function AiSection({ config }: AiSectionProps) {
  const { hash } = useLocation();

  // Verweise wie /einstellungen#ki-datenschutz („Was genau?" bei den Vorschlägen): dorthin, sobald der Abschnitt steht.
  useEffect(() => {
    const target = decodeURIComponent(hash.replace(/^#/, ""));
    const element = ANCHORS.has(target) ? document.getElementById(target) : null;
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "start" });
    }
  }, [hash]);

  const state = config.state;
  return (
    <Section title="KI-Vorschläge" id="ki" description="Rezeptideen von Claude für „Was koche ich?“, mit einem eigenen API-Schlüssel von Anthropic.">
      {state.status === "loading" ? (
        <List>
          <ListRow label={<span className={styles.muted}>Einrichtung der KI-Vorschläge wird geladen …</span>}>
            <Spinner label="Einrichtung der KI-Vorschläge wird geladen" />
          </ListRow>
        </List>
      ) : state.status === "error" ? (
        state.code === "not_supported" ? (
          <Notice tone="info" role="status">
            Dieser Server kennt noch keine KI-Vorschläge. Erst Stowly aktualisieren.
          </Notice>
        ) : (
          <Notice
            tone={state.offline ? "warn" : "danger"}
            role="status"
            action={
              <Button size="sm" onClick={config.reload}>
                Erneut versuchen
              </Button>
            }
          >
            {state.message}
          </Notice>
        )
      ) : (
        <AiForm config={state.value} onSaved={config.set} />
      )}
      <div id="ki-datenschutz">
        <Notice tone="neutral" icon={<ShieldCheckIcon />} title="Datenschutz">
          {AI_PRIVACY}
        </Notice>
      </div>
      <p className={styles.foot}>
        Schlüssel anlegen auf{" "}
        <a className={styles.external} href={ANTHROPIC_CONSOLE} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon size={16} aria-hidden="true" />
          console.anthropic.com
        </a>
        ; am besten einen eigenen mit Ausgabenlimit.
      </p>
    </Section>
  );
}
