/**
 * KI-Vorschläge für „Was koche ich?" (seit 0.6.0; docs/plan-0.6.md, 3; docs/sync-protokoll.md, 11.13):
 * Schlüssel und Modell einrichten, prüfen, Aufträge starten und auf sie warten.
 *
 * Ein eigener, nachgeladener Teil des Kerns wie admin.ts: `createCore` holt ihn erst beim ersten
 * Aufruf (index.ts, `later`). So bleibt er aus dem Hauptpaket. Alles braucht den Server und eine
 * Anmeldung (`CoreRuntime.server`). Gespeichert wird nichts, nur die Kennung des zuletzt gestarteten
 * Auftrags im Arbeitsspeicher (`lastJob`): So findet die Seite nach einem Wechsel zu ihm zurück.
 *
 * Fehler von Anthropic sind keine Fehler dieser Aufrufe: Sie stehen in `AiCheck.state` und im fertigen
 * Auftrag (`CookJob.problem`). Jede Antwort wird auf ihre Form geprüft; was nicht so aussieht, stammt
 * nicht vom Stowly-Server ("offline").
 */
import { checkAiKey, checkCookInput } from "@/contract/ai";
import {
  CoreError,
  COOK_WAIT_MS,
  ENDPOINTS,
  isCoreError,
  type AiApi,
  type AiCheck,
  type AiCheckInput,
  type AiConfig,
  type AiConfigChanges,
  type CookIdea,
  type CookIdeas,
  type CookIdeasInput,
  type CookJob,
  type CookJobState,
  type CookProblem,
  type CookWaitOptions,
} from "@/contract";

import type { CoreRuntime } from "./api/runtime";
import { ApiClient, isCount, isRecord, isText, isTextOrNull, REQUEST_TIMEOUT_MS, type FetchLike } from "./http";
import type { SchedulerTimers } from "./sync/scheduler";

/**
 * Die Prüfung fragt Anthropic nach dem Modell; der Server wartet darauf mit eigenen Fristen (Verbindung
 * 5 Sekunden, eine Wiederholung). Dazu der Weg.
 */
export const AI_CHECK_TIMEOUT_MS = 30_000;

/** Wartezeiten von `wait` zwischen den Abfragen: 1 Sekunde, 2 weitere, dann immer die letzte (3 Sekunden). */
export const COOK_POLL_DELAYS_MS: readonly number[] = [1_000, 2_000, 3_000];

const CONFIG_SOURCES: ReadonlySet<string> = new Set(["env", "app", "default"]);
const JOB_STATES: ReadonlySet<string> = new Set<CookJobState>(["running", "done", "failed"]);
const JOB_ID = /^[0-9a-f]{32}$/;

const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

function isAiConfig(value: unknown): value is AiConfig {
  return (
    isRecord(value) &&
    isText(value.source) &&
    CONFIG_SOURCES.has(value.source) &&
    isBool(value.key_set) &&
    isTextOrNull(value.key_set_at) &&
    isText(value.model) &&
    isText(value.model_source) &&
    isBool(value.configured) &&
    isTextOrNull(value.problem) &&
    isCount(value.used_today) &&
    isCount(value.daily_limit)
  );
}

function isAiCheck(value: unknown): value is AiCheck {
  return isRecord(value) && isText(value.state) && isText(value.message) && isText(value.model);
}

function isCookIdea(value: unknown): value is CookIdea {
  return (
    isRecord(value) &&
    isText(value.title) &&
    isText(value.summary) &&
    (value.minutes === null || isCount(value.minutes)) &&
    Array.isArray(value.uses) &&
    value.uses.every((use) => isRecord(use) && isText(use.product_id) && isText(use.name)) &&
    isTextList(value.missing) &&
    isTextList(value.steps) &&
    isText(value.search)
  );
}

function isCookIdeas(value: unknown): value is CookIdeas {
  return (
    isRecord(value) &&
    Array.isArray(value.ideas) &&
    value.ideas.every(isCookIdea) &&
    isText(value.model) &&
    isBool(value.fallback) &&
    isCount(value.stock_count) &&
    isBool(value.truncated)
  );
}

function isCookProblem(value: unknown): value is CookProblem {
  return isRecord(value) && isText(value.reason) && isText(value.message) && (value.retry_after_s === null || isCount(value.retry_after_s)) && isTextOrNull(value.category);
}

function isCookJob(value: unknown): value is CookJob {
  return (
    isRecord(value) &&
    isText(value.id) &&
    JOB_ID.test(value.id) &&
    isText(value.state) &&
    JOB_STATES.has(value.state) &&
    isText(value.started_at) &&
    isTextOrNull(value.finished_at) &&
    (value.result === null || isCookIdeas(value.result)) &&
    (value.problem === null || isCookProblem(value.problem)) &&
    isCount(value.used_today) &&
    isCount(value.daily_limit)
  );
}

/** Die Aufrufe dieses Teils, gebaut auf `ApiClient`. */
class AiClient extends ApiClient {
  config(token: string): Promise<AiConfig> {
    return this.checked(ENDPOINTS.get_ai_config, ENDPOINTS.get_ai_config.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isAiConfig);
  }

  updateConfig(token: string, changes: AiConfigChanges): Promise<AiConfig> {
    return this.checked(ENDPOINTS.update_ai_config, ENDPOINTS.update_ai_config.path, { token, body: changes, timeoutMs: REQUEST_TIMEOUT_MS }, isAiConfig);
  }

  check(token: string, input: AiCheckInput): Promise<AiCheck> {
    return this.checked(ENDPOINTS.check_ai, ENDPOINTS.check_ai.path, { token, body: input, timeoutMs: AI_CHECK_TIMEOUT_MS }, isAiCheck);
  }

  start(token: string, input: CookIdeasInput): Promise<CookJob> {
    return this.checked(ENDPOINTS.start_cook_ideas, ENDPOINTS.start_cook_ideas.path, { token, body: input, timeoutMs: REQUEST_TIMEOUT_MS }, isCookJob);
  }

  job(token: string, id: string): Promise<CookJob> {
    const path = ENDPOINTS.get_cook_ideas.path.replace("{job_id}", encodeURIComponent(id));
    return this.checked(ENDPOINTS.get_cook_ideas, path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isCookJob);
  }
}

/** Nur die vorhandenen Felder; ein Schlüssel vorab geprüft und ohne Leerraum am Rand, null bleibt null (entfernen). */
function cleanChanges(changes: AiConfigChanges): AiConfigChanges {
  const result: AiConfigChanges = {};
  if (changes.key !== undefined) {
    result.key = changes.key === null ? null : checkAiKey(changes.key);
  }
  if (changes.model !== undefined) {
    result.model = changes.model;
  }
  return result;
}

function cleanCheck(input: AiCheckInput | undefined): AiCheckInput {
  const result: AiCheckInput = {};
  if (typeof input?.key === "string" && input.key.trim() !== "") {
    result.key = checkAiKey(input.key);
  }
  if (input?.model !== undefined) {
    result.model = input.model;
  }
  return result;
}

/** Der Auftrag, wie ihn der Server nach seiner Frist meldet: gescheitert mit `timeout`. */
function timedOut(job: CookJob, at: Date): CookJob {
  return {
    ...job,
    state: "failed",
    finished_at: at.toISOString(),
    result: null,
    problem: { reason: "timeout", message: "Claude hat in der Zeit keine Vorschläge geliefert.", retry_after_s: null, category: null },
  };
}

export interface AiOptions {
  /** Zeitgeber für die Pausen von `wait`. Vorgabe: die des Browsers. Für Tests (`CoreOptions.timers`). */
  timers?: SchedulerTimers;
}

/** KI-Vorschläge für `createCore`; `fetchFn` ist das `fetch` des Kerns. */
export function createAi(runtime: CoreRuntime, fetchFn: FetchLike, options: AiOptions = {}): AiApi {
  const client = new AiClient(fetchFn);
  const server = runtime.server.bind(runtime);
  const timers = options.timers;
  let lastJobId: string | null = null;

  /** Wartet `ms` Millisekunden; mit dem Signal scheitert es sofort mit dessen Grund. */
  function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        if (timers) {
          timers.clear(handle);
        } else {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        }
        reject(signal?.reason);
      };
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const handle: unknown = timers ? timers.set(done, ms) : setTimeout(done, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  function job(id: string): Promise<CookJob> {
    if (typeof id !== "string" || !JOB_ID.test(id)) {
      return Promise.reject(new CoreError("not_found", "Diesen Auftrag gibt es nicht."));
    }
    return server((token) => client.job(token, id));
  }

  return {
    load: () => server((token) => client.config(token)),
    async update(changes) {
      const wanted = cleanChanges(changes);
      return server((token) => client.updateConfig(token, wanted));
    },
    async check(input) {
      const wanted = cleanCheck(input);
      return server((token) => client.check(token, wanted));
    },
    async start(input) {
      const wanted = checkCookInput(input);
      const started = await server((token) => client.start(token, wanted));
      lastJobId = started.id;
      return started;
    },
    job,
    async wait(id, waitOptions: CookWaitOptions = {}) {
      const { signal, onTick } = waitOptions;
      if (typeof id !== "string" || !JOB_ID.test(id)) {
        throw new CoreError("not_found", "Diesen Auftrag gibt es nicht.");
      }
      const deadline = runtime.now().getTime() + COOK_WAIT_MS;
      let last: CookJob | null = null;
      let failure: CoreError | null = null;
      for (let round = 0; ; round += 1) {
        await pause(COOK_POLL_DELAYS_MS[Math.min(round, COOK_POLL_DELAYS_MS.length - 1)] ?? 3_000, signal);
        try {
          last = await job(id);
          failure = null;
        } catch (error) {
          // Ein kurzer Ausfall unterbricht das Warten nicht; alles andere (abgelaufen, abgemeldet) schon.
          if (!isCoreError(error, "offline")) {
            throw error;
          }
          failure = error;
        }
        if (signal?.aborted) {
          throw signal.reason;
        }
        if (last !== null && last.state !== "running") {
          return last;
        }
        if (failure === null && last !== null) {
          onTick?.(last);
        }
        if (runtime.now().getTime() >= deadline) {
          if (failure !== null || last === null) {
            throw failure ?? new CoreError("offline", "Der Server ist nicht erreichbar.");
          }
          return timedOut(last, runtime.now());
        }
      }
    },
    async lastJob() {
      return lastJobId;
    },
  };
}
