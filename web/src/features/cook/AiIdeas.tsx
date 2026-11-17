import { useEffect, useState, type FormEvent } from "react";

import { LIMITS, ROUTES, useCore, useLive, type CookJob } from "@/contract";
import { useLoaded } from "@/features/settings/loaded";
import type { ProductGroup } from "@/features/stock/model";
import { Notice, TextLink, useNow } from "@/ui";
import { Button, ButtonLink, Spinner, TextField } from "@/ui/base";
import { ChefHatIcon, CloudOffIcon, SettingsIcon, WarningIcon } from "@/ui/icons";

import styles from "./CookPage.module.css";
import { IdeaCard } from "./IdeaCard";
import { focusIds, type Ingredient } from "./model";
import { failureNotice, modelName, startNotice, type CookNotice } from "./texts";
import { startedAt, useCookJob } from "./useCookJob";

/** Wo es in den Einstellungen um die KI-Vorschläge geht, und wo der Hinweis zum Datenschutz steht. */
const SETTINGS = { pathname: ROUTES.settings, hash: "#ki" };
const PRIVACY = { pathname: ROUTES.settings, hash: "#ki-datenschutz" };

const OFFLINE = "Ob Vorschläge von Claude eingerichtet sind, weiß nur der Server, und der ist gerade nicht erreichbar.";

/** Ein Fehlschlag als Hinweis, mit dem Weg in die Einstellungen, wo der hilft. */
function Problem({ notice }: { notice: CookNotice }) {
  return (
    <Notice
      tone={notice.later ? "warn" : "danger"}
      icon={<WarningIcon />}
      title={notice.title}
      role="alert"
      action={
        notice.settings ? (
          <ButtonLink size="sm" to={SETTINGS} icon={<SettingsIcon />}>
            Zu den Einstellungen
          </ButtonLink>
        ) : undefined
      }
    >
      {notice.text}
    </Notice>
  );
}

/** Während Claude überlegt: die Sekunden seit dem Start, und wie lange es dauern kann. */
function Thinking({ job }: { job: CookJob }) {
  const now = useNow(1_000);
  const seconds = Math.max(0, Math.round((now - startedAt(job)) / 1000));
  return (
    <Notice tone="info" icon={<Spinner size={18} />} title="Claude überlegt …" role="status">
      <span className={styles.seconds} aria-hidden="true">
        {seconds} s ·{" "}
      </span>
      Das dauert bis zu einer Minute.
    </Notice>
  );
}

/** Die Vorschläge eines fertigen Auftrags als Karten. */
function Results({ job, groups }: { job: CookJob; groups: ReadonlyMap<string, ProductGroup> }) {
  const result = job.result;
  if (job.state === "failed" || result === null) {
    return job.problem ? <Problem notice={failureNotice(job.problem)} /> : null;
  }
  return (
    <>
      {result.fallback ? (
        <Notice tone="info" role="status">
          Das gewählte Modell hat abgelehnt; geantwortet hat ein Ersatzmodell: {modelName(result.model)}.
        </Notice>
      ) : null}
      {result.truncated ? <p className={styles.small}>Der Vorrat ist groß: An Claude gingen die {result.stock_count} Produkte, die am dringendsten sind.</p> : null}
      {result.ideas.length === 0 ? (
        <p className={styles.muted}>Claude hat diesmal keinen Vorschlag gemacht. Mit einem anderen Wunsch noch einmal versuchen.</p>
      ) : (
        <div className={styles.cards}>
          {result.ideas.map((idea, index) => (
            <IdeaCard key={`${job.id}-${String(index)}`} idea={idea} model={result.model} groups={groups} />
          ))}
        </div>
      )}
    </>
  );
}

export interface AiIdeasProps {
  /** Die gewählten Zutaten: Ihre Produkte gehen als Schwerpunkte mit (`focus`). */
  ingredients: readonly Ingredient[];
  /** Der Bestand je Produkt, für Name und MHD in den Karten. */
  groups: ReadonlyMap<string, ProductGroup>;
}

/**
 * Vorschläge von Claude (docs/plan-0.6.md, „So sieht es für dich aus"): ein Wunsch, der Knopf, der
 * Zähler für heute; während des Auftrags der Fortschritt, danach drei Karten oder der Grund, warum es
 * nicht ging. Ohne Schlüssel führt ein Hinweis in die Einstellungen; ohne Server geht es nicht, die
 * Such-Links darüber schon.
 */
export function AiIdeas({ ingredients, groups }: AiIdeasProps) {
  const core = useCore();
  const online = useLive(core.sync.status)?.online;
  const config = useLoaded(() => core.ai.load(), OFFLINE);
  const { view, start } = useCookJob();
  const [wish, setWish] = useState("");
  const offline = online === false;
  const phase = view.phase;
  const job = view.phase === "running" || view.phase === "finished" ? view.job : null;
  const settings = config.state.status === "ready" ? config.state.value : null;

  // Nach einem Auftrag stimmt der Zähler für heute wieder mit dem Server überein.
  const reload = config.reload;
  useEffect(() => {
    if (phase === "finished" || phase === "error") {
      reload();
    }
  }, [phase, reload]);

  const used = job?.used_today ?? settings?.used_today;
  const limit = job?.daily_limit ?? settings?.daily_limit;
  const busy = phase === "starting" || phase === "running";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || offline) {
      return;
    }
    start({ wish, focus: focusIds(ingredients) });
  }

  let setup = null;
  if (offline) {
    setup = (
      <Notice tone="warn" icon={<CloudOffIcon />} title="Ohne Verbindung keine Vorschläge" role="status">
        Vorschläge von Claude gehen nur über den Stowly-Server, und der ist gerade nicht erreichbar. Die Such-Links oben gehen trotzdem.
      </Notice>
    );
  } else if (config.state.status === "loading") {
    setup = (
      <p className={styles.muted}>
        <Spinner label="Einrichtung der KI-Vorschläge wird geladen" />
      </p>
    );
  } else if (config.state.status === "error") {
    setup =
      config.state.code === "not_supported" ? (
        <Notice tone="info" role="status">
          Dieser Server kennt noch keine Vorschläge von Claude. Erst Stowly aktualisieren.
        </Notice>
      ) : (
        <Notice
          tone={config.state.offline ? "warn" : "danger"}
          role="status"
          action={
            <Button size="sm" onClick={config.reload}>
              Erneut versuchen
            </Button>
          }
        >
          {config.state.message}
        </Notice>
      );
  } else if (settings && !settings.configured) {
    setup = (
      <Notice
        tone="info"
        title={settings.problem ? "API-Schlüssel fehlt" : "Noch nicht eingerichtet"}
        role="status"
        action={
          <ButtonLink size="sm" to={SETTINGS} icon={<SettingsIcon />}>
            Einrichten
          </ButtonLink>
        }
      >
        {settings.problem ?? "Für Vorschläge von Claude braucht Stowly einen API-Schlüssel von Anthropic. Er gehört in die Einstellungen unter „KI-Vorschläge“."}
      </Notice>
    );
  }

  const ready = settings?.configured === true && !offline;

  return (
    <div className={styles.ai}>
      {setup}
      {ready ? (
        <form className={styles.ask} onSubmit={submit} noValidate>
          <TextField
            label="Wunsch"
            placeholder="etwa vegetarisch, schnell, für 2"
            hint={`${String(wish.length)} von ${String(LIMITS.cook_wish)} Zeichen`}
            maxLength={LIMITS.cook_wish}
            autoComplete="off"
            enterKeyHint="send"
            value={wish}
            onChange={(event) => setWish(event.target.value)}
          />
          <div className={styles.askActions}>
            <Button type="submit" variant="primary" icon={<ChefHatIcon />} busy={busy}>
              Vorschläge von Claude
            </Button>
            {used !== undefined && limit !== undefined ? <span className={styles.counter}>heute {used} von {limit}</span> : null}
          </div>
          <p className={styles.small}>
            Die Vorratsliste geht an Anthropic. <TextLink to={PRIVACY}>Was genau?</TextLink>
          </p>
        </form>
      ) : null}
      {view.phase === "running" ? <Thinking job={view.job} /> : null}
      {view.phase === "error" ? <Problem notice={startNotice(view.error, limit ?? null)} /> : null}
      {view.phase === "finished" ? <Results job={view.job} groups={groups} /> : null}
    </div>
  );
}
