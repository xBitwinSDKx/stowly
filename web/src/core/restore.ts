/**
 * Eine Sicherung zurückspielen (docs/sync-protokoll.md, 11.9; docs/plan-einrichtung-b.md, Abschnitt 2):
 * hochladen (mit Fortschritt), prüfen, anwenden und auf den Neustart warten; beim ersten Start danach
 * mit dem Zugang anmelden, den der Server beim Anwenden ausgestellt hat.
 *
 * Ein eigener, nachgeladener Teil des Kerns (index.ts, `later`): Er gehört nicht ins Hauptpaket.
 *
 * - Angemeldet gilt alles für den laufenden Stowly und geht mit dem Token dieses Geräts
 *   (`CoreRuntime.server`).
 * - Abgemeldet nur beim ersten Start, ohne Token: Der Server lässt das nur zu, solange er kein
 *   Passwort hat.
 * - Der geheime Schlüssel geht nur in den Rumpf von `check`; hier wird er nirgends gespeichert.
 *
 * Hochgeladen wird im Browser über `XMLHttpRequest`, weil nur das den Fortschritt des Sendens
 * meldet; mit einem eigenen `fetch` (Tests) über dieses.
 */
import {
  CoreError,
  ENDPOINTS,
  isCoreError,
  LIMITS,
  RESTORE_MAX_BYTES,
  RESTORE_RESTART_TIMEOUT_MS,
  type LoginResponse,
  type RestoreApi,
  type RestoreApplied,
  type RestoreApplyInput,
  type RestorePreview,
  type RestoreStatus,
  type RestoreUpload,
  type UploadProgress,
} from "@/contract";

import { toCoreError, type CoreRuntime } from "./api/runtime";
import { checkDeviceName } from "./api/validate";
import { ApiClient, errorFrom, HEALTH_TIMEOUT_MS, isCount, isRecord, isText, isTextOrNull, OFFLINE_MESSAGE, REQUEST_TIMEOUT_MS, type FetchLike } from "./http";

/** Ohne Fortschritt (über `fetch`) darf das Hochladen so lange dauern. */
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;
/** Über `XMLHttpRequest`: So lange darf der Fortschritt stehen, bevor das Hochladen als abgebrochen gilt. */
export const UPLOAD_STALL_MS = 60_000;
/** Nach dem letzten Byte: So lange darf der Server zum Ablegen und Erkennen der Datei brauchen. */
export const UPLOAD_ANSWER_MS = 180_000;
/** Entschlüsseln, prüfen und hochziehen dauert bei großen Sicherungen auf einem kleinen NAS. */
export const CHECK_TIMEOUT_MS = 300_000;
/** Das Bereitlegen des Kandidaten kopiert eine Datei. */
export const APPLY_TIMEOUT_MS = 120_000;
/** In diesem Abstand fragt der Kern nach dem Anwenden, ob Stowly wieder da ist. */
export const RESTART_POLL_MS = 1_000;

const TOO_BIG = `Die Datei ist zu groß: Eine Sicherung darf höchstens ${String(RESTORE_MAX_BYTES / 1024 / 1024)} MiB haben.`;
const GONE = "Stowly ist nach dem Neustart nicht wieder erreichbar. Bitte auf dem Server nachsehen und die Seite dann neu laden.";

const KINDS: ReadonlySet<string> = new Set(["age", "gzip", "sqlite"]);
const STATES: ReadonlySet<string> = new Set(["idle", "pending", "done", "undone", "failed"]);

function isUpload(value: unknown): value is RestoreUpload {
  return isRecord(value) && isText(value.upload_id) && isText(value.kind) && KINDS.has(value.kind) && isCount(value.size);
}

function isPreview(value: unknown): value is RestorePreview {
  const counts = isRecord(value) ? value.counts : undefined;
  return (
    isRecord(value) &&
    isText(value.restore_id) &&
    isText(value.expires_at) &&
    isText(value.kind) &&
    typeof value.schema_version === "number" &&
    typeof value.current_schema_version === "number" &&
    isTextOrNull(value.last_activity_at) &&
    typeof value.has_password === "boolean" &&
    isCount(value.devices) &&
    isRecord(counts) &&
    isCount(counts.products) &&
    isCount(counts.items) &&
    isCount(counts.zones) &&
    isCount(counts.shopping)
  );
}

function isApplied(value: unknown): value is RestoreApplied {
  const login = isRecord(value) ? value.login : undefined;
  return isRecord(value) && (login === null || (isRecord(login) && isText(login.token) && isRecord(login.device) && isText(login.device.id)));
}

function isStatus(value: unknown): value is RestoreStatus {
  return isRecord(value) && isText(value.state) && STATES.has(value.state) && isTextOrNull(value.at) && isTextOrNull(value.message) && isTextOrNull(value.undo_until);
}

/** 413 (`payload_too_large`) kommt beim Kern als "internal" an: als "invalid", mit dem Satz des Servers. */
function tooBigAsInvalid(error: unknown): CoreError {
  const failure = toCoreError(error);
  if (failure.details.status !== 413) {
    return failure;
  }
  const said = failure.message.trim() !== "" && failure.message !== failure.code && failure.message !== "payload_too_large" ? failure.message : TOO_BIG;
  return new CoreError("invalid", said, { ...failure.details });
}

class RestoreClient extends ApiClient {
  upload(token: string | null, file: Blob): Promise<RestoreUpload> {
    return this.checked(ENDPOINTS.upload_restore, ENDPOINTS.upload_restore.path, { token, body: file, timeoutMs: UPLOAD_TIMEOUT_MS }, isUpload);
  }

  check(token: string | null, uploadId: string, identity: string | null): Promise<RestorePreview> {
    const body = identity === null ? { upload_id: uploadId } : { upload_id: uploadId, identity };
    return this.checked(ENDPOINTS.check_restore, ENDPOINTS.check_restore.path, { token, body, timeoutMs: CHECK_TIMEOUT_MS }, isPreview);
  }

  apply(token: string | null, input: RestoreApplyInput): Promise<RestoreApplied> {
    return this.checked(ENDPOINTS.apply_restore, ENDPOINTS.apply_restore.path, { token, body: input, timeoutMs: APPLY_TIMEOUT_MS }, isApplied);
  }

  status(token: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<RestoreStatus> {
    return this.checked(ENDPOINTS.get_restore_status, ENDPOINTS.get_restore_status.path, { token, timeoutMs }, isStatus);
  }

  undo(token: string): Promise<RestoreApplied> {
    return this.checked(ENDPOINTS.undo_restore, ENDPOINTS.undo_restore.path, { token, timeoutMs: APPLY_TIMEOUT_MS }, isApplied);
  }

  async discardPrevious(token: string): Promise<void> {
    await this.call(ENDPOINTS.delete_restore_previous, ENDPOINTS.delete_restore_previous.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
  }
}

/**
 * Hochladen im Browser über `XMLHttpRequest`, mit Fortschritt. Steht der Fortschritt eine Minute
 * still, oder antwortet der Server nach dem letzten Byte nicht in `UPLOAD_ANSWER_MS`, gilt der
 * Server als nicht erreichbar.
 */
function uploadWithProgress(file: Blob, token: string | null, onProgress: ((progress: UploadProgress) => void) | undefined): Promise<RestoreUpload> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => request.abort(), ms);
    };
    const offline = () => {
      clearTimeout(timer);
      reject(new CoreError("offline", OFFLINE_MESSAGE));
    };
    request.open("PUT", ENDPOINTS.upload_restore.path);
    request.setRequestHeader("accept", "application/json");
    request.setRequestHeader("content-type", "application/octet-stream");
    if (token) {
      request.setRequestHeader("authorization", `Bearer ${token}`);
    }
    request.upload.onprogress = (event) => {
      wait(UPLOAD_STALL_MS);
      onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : file.size });
    };
    request.upload.onload = () => wait(UPLOAD_ANSWER_MS);
    request.onerror = offline;
    request.onabort = offline;
    request.ontimeout = offline;
    request.onload = () => {
      clearTimeout(timer);
      const status = request.status;
      if (status < 200 || status > 599) {
        offline();
        return;
      }
      const headers: Record<string, string> = { "content-type": request.getResponseHeader("content-type") ?? "" };
      const retry = request.getResponseHeader("retry-after");
      if (retry) {
        headers["retry-after"] = retry;
      }
      const response = new Response(status === 204 ? null : request.responseText, { status, headers });
      if (!response.ok) {
        void errorFrom(response).then(reject, offline);
        return;
      }
      response.json().then((answer: unknown) => (isUpload(answer) ? resolve(answer) : offline()), offline);
    };
    wait(UPLOAD_STALL_MS);
    request.send(file);
  });
}

export interface RestoreContext {
  runtime: CoreRuntime;
  fetch: FetchLike;
  /** true: hochladen über `XMLHttpRequest` mit Fortschritt (die echte App); sonst über `fetch`. */
  xhr: boolean;
  /**
   * Meldet dieses Gerät mit einem Zugang an, den der Server schon ausgestellt hat, und holt den
   * Bestand, genau wie `session.login` (index.ts, `signInWith`).
   */
  signIn(login: LoginResponse, deviceName: string): Promise<void>;
  /** Wartet `ms` Millisekunden; Vorgabe `setTimeout`. Für Tests. */
  sleep?(ms: number): Promise<void>;
}

export function createRestore(context: RestoreContext): RestoreApi {
  const { runtime } = context;
  const client = new RestoreClient(context.fetch);
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function signedIn(): boolean {
    const session = runtime.store.snapshot.session;
    return session?.status === "signed_in" && session.token !== null;
  }

  /** Angemeldet mit dem Token (laufender Stowly), sonst ohne (erster Start). Fehler immer als CoreError. */
  async function call<T>(work: (token: string | null) => Promise<T>): Promise<T> {
    await runtime.ready;
    if (signedIn()) {
      return runtime.server(work);
    }
    try {
      return await work(null);
    } catch (error) {
      throw toCoreError(error);
    }
  }

  /**
   * Fragt `attempt`, bis es etwas liefert, höchstens `RESTORE_RESTART_TIMEOUT_MS`: null und der
   * Fehler "offline" heißen „noch nicht" (der Server startet gerade neu). Andere Fehler gehen durch.
   */
  async function until<T>(attempt: () => Promise<T | null>): Promise<T> {
    const deadline = Date.now() + RESTORE_RESTART_TIMEOUT_MS;
    for (;;) {
      try {
        const result = await attempt();
        if (result !== null) {
          return result;
        }
      } catch (error) {
        if (!isCoreError(error, "offline")) {
          throw error;
        }
      }
      if (Date.now() > deadline) {
        throw new CoreError("offline", GONE);
      }
      await sleep(RESTART_POLL_MS);
    }
  }

  return {
    async upload(file, options) {
      if (!(file instanceof Blob) || file.size === 0) {
        throw new CoreError("invalid", "Die Datei ist leer.");
      }
      if (file.size > RESTORE_MAX_BYTES) {
        throw new CoreError("invalid", TOO_BIG);
      }
      const onProgress = options?.onProgress;
      try {
        const uploaded = await call((token) => (context.xhr ? uploadWithProgress(file, token, onProgress) : client.upload(token, file)));
        onProgress?.({ loaded: file.size, total: file.size });
        return uploaded;
      } catch (error) {
        throw tooBigAsInvalid(error);
      }
    },

    async check(uploadId, identity) {
      const secret = typeof identity === "string" && identity.trim() !== "" ? identity : null;
      if (secret !== null && secret.length > LIMITS.restore_identity) {
        throw new CoreError("invalid", "Das ist zu viel Text für einen Schlüssel.", { reason: "not_a_key" });
      }
      try {
        return await call((token) => client.check(token, uploadId, secret));
      } catch (error) {
        // Entpackt zu groß: auch 413.
        throw tooBigAsInvalid(error);
      }
    },

    async apply(input) {
      await runtime.ready;
      const password = input.password;
      if (typeof password !== "string" || password === "" || password.length > LIMITS.password) {
        throw new CoreError("invalid_password", "Das Passwort stimmt nicht.");
      }
      if (signedIn()) {
        // Der laufende Stowly behält alle Anmeldungen; ein Gerätename gilt hier nicht.
        await call((token) => client.apply(token, { restore_id: input.restore_id, password }));
        return;
      }
      // Erster Start: Das neue Gerät entsteht beim Anwenden gleich mit.
      const name = checkDeviceName(input.device_name);
      const applied = await call((token) => client.apply(token, { restore_id: input.restore_id, password, device_name: name }));
      const login = applied.login;
      if (login === null) {
        throw new CoreError("internal", "Der Server hat beim Zurückspielen keinen Zugang für dieses Gerät geliefert. Bitte nach dem Neustart anmelden.");
      }
      // Erst wenn Stowly nach dem Neustart wieder eingerichtet antwortet, gilt der Zugang.
      await until(async () => ((await client.health())?.configured === true ? true : null));
      await context.signIn(login, name);
    },

    status: () => runtime.server((token) => client.status(token)),

    async undo() {
      await runtime.server((token) => client.undo(token));
    },

    discardPrevious: () => runtime.server((token) => client.discardPrevious(token)),

    async waitForRestart() {
      await runtime.ready;
      // Solange der Server nicht antwortet oder noch „pending" meldet, läuft der Neustart.
      return until(async () => {
        const status = await runtime.server((token) => client.status(token, HEALTH_TIMEOUT_MS));
        return status.state === "pending" ? null : status;
      });
    },
  };
}
