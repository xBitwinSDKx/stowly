/**
 * Die Verbindung zum Druckdienst eines Druckers aufnehmen: Zustand abfragen
 * (`GET /v1/health`) und sagen, woran es liegt, wenn es nicht geht (`PrinterProblem`).
 *
 * Drucker am Server: eine Abfrage an `<Ursprung der App>/print` mit dem Geräte-Token.
 *
 * Direkter Drucker (docs/etiketten.md, 5.5 und 5.6): die Adressen aus `Printer.direct.urls` der
 * Reihe nach; die erste, die sich ausweist, gilt. Vor jeder Anfrage steht die Erlaubnis des
 * Browsers für das lokale Netzwerk:
 *
 *   abgelehnt     es geht keine Anfrage hinaus ("permission")
 *   noch offen    die Anfrage würde die Nachfrage des Browsers auslösen; das darf nur auf eine
 *                 Handlung des Anwenders hin geschehen (`manual`). Selbsttätig wird gewartet.
 *                 Auf Wunsch des Anwenders bekommt diese Anfrage statt 1,5 s bis zu 15 s, damit
 *                 er die Nachfrage beantworten kann (`PERMISSION_PROMPT_TIMEOUT_MS`).
 *                 Ausnahme: Der Browser meldet „noch offen" auch dort, wo er gar nicht fragt,
 *                 nämlich wenn die App selbst aus dem lokalen Netzwerk kommt (der übliche Fall
 *                 beim Server zu Hause). Hat eine Anfrage auf Wunsch des Anwenders einmal eine
 *                 Antwort bekommen und steht die Erlaubnis danach immer noch auf „offen", merkt
 *                 sich das Gerät das (`promptFree`), und von da an läuft es auch von selbst.
 *   erteilt oder  die Anfrage läuft
 *   unbekannt
 */
import type { Printer, ServiceHealth, ServicePrinter } from "@/contract/api.gen";
import type { PrinterProblem } from "@/contract/core";

import { addressSpaceOf, baseOf, newNonce, proofOf, sameProof, type AddressSpace, type PermissionReader } from "./address";
import { HEALTH_TIMEOUT_MS, type PrintServiceClient, type ServiceEndpoint } from "./client";

export const PRINT_SERVICE_APP = "stowly-print";

/**
 * Zeitgrenze einer Abfrage, die die Nachfrage des Browsers nach dem lokalen Netzwerk auslösen
 * kann: Die Erlaubnis steht auf „noch offen", der Adressraum ist nicht als „fragt nie" bekannt,
 * und der Versuch kommt vom Anwender (`flush`, `probe`). Der Browser hält die Anfrage an, bis der
 * Anwender geantwortet hat; die üblichen 1,5 s reichen nicht einmal zum Lesen. Ob die Nachfrage
 * stehen bleibt, wenn die Anfrage vorher aufgibt, ist nicht sicher; also bekommt der Anwender
 * Zeit, sie zu lesen und zu beantworten, bevor die Anfrage aufgibt.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 15_000;

/**
 * So lange dauert eine solche Abfrage über alle Adressen eines Druckers zusammen höchstens: Wer
 * nicht im WLAN des Pi ist, wartet dort auf „nicht erreichbar", und das soll nicht über alle
 * Adressen hinweg je 15 s dauern. Die erste Adresse bekommt bis zu 15 s, jede weitere, die die
 * Nachfrage auslösen kann, den Rest bis hierhin, mindestens aber die üblichen 1,5 s. Die beiden
 * vorgesehenen Adressen (HTTPS, dann HTTP) brauchen so zusammen höchstens 20 s.
 */
export const PERMISSION_PROMPT_BUDGET_MS = 20_000;

/**
 * Die Zeitgrenze einer Abfrage des Zustands. `mayPrompt`: Die Anfrage kann die Nachfrage des
 * Browsers auslösen (siehe oben); sonst gelten immer die üblichen 1,5 s.
 */
export function healthTimeout(mayPrompt: boolean, startedAtMs: number, nowMs: number): number {
  if (!mayPrompt) {
    return HEALTH_TIMEOUT_MS;
  }
  const left = startedAtMs + PERMISSION_PROMPT_BUDGET_MS - nowMs;
  return Math.max(HEALTH_TIMEOUT_MS, Math.min(PERMISSION_PROMPT_TIMEOUT_MS, left));
}

export interface Connection {
  printer: Printer;
  endpoint: ServiceEndpoint;
  /** Basis-Adresse, über die der Dienst geantwortet hat; null beim Drucker am Server. */
  url: string | null;
  health: ServiceHealth;
  /** Name des Druckers im Auftrag: am Server die `Printer.id`, am Pi `direct.printer` (null = Standarddrucker). */
  queue: string | null;
  /** Der angesprochene Drucker, wie ihn der Dienst meldet; null = Der Dienst hat ihn nicht. */
  service: ServicePrinter | null;
}

export type ConnectResult =
  /** `problem` ist höchstens "unknown_printer": Der Dienst ist da, kennt den Drucker aber nicht. */
  | { ok: true; connection: Connection; problem: PrinterProblem | null }
  | {
      ok: false;
      problem: PrinterProblem;
      /** Der Druckdienst des Servers hat das Geräte-Token abgelehnt: Das Gerät ist abgemeldet. */
      unauthorized?: boolean;
      /** Es ging keine Anfrage hinaus, weil sie die Nachfrage des Browsers ausgelöst hätte. */
      waiting_for_permission?: boolean;
    };

export interface ConnectOptions {
  client: PrintServiceClient;
  /** Geräte-Token für den Druckdienst des Servers. */
  deviceToken: string;
  secureContext: boolean;
  readPermission: PermissionReader;
  /** Auf eine Handlung des Anwenders hin: Die Nachfrage des Browsers darf kommen. */
  manual: boolean;
  /** Fragt der Browser für diesen Adressraum erfahrungsgemäß nicht nach, obwohl die Erlaubnis „offen" ist? */
  promptFree(space: AddressSpace): boolean;
  /** Eine Anfrage in diesen Adressraum wurde beantwortet, und die Erlaubnis steht weiter auf „offen". */
  learnPromptFree(space: AddressSpace): void;
  /** Das Papier des Haushalts (`media` der Abfrage, seit 0.5.0); null = keines bekannt. */
  media?: string | null;
}

async function connectServer(printer: Printer, options: ConnectOptions): Promise<ConnectResult> {
  const endpoint: ServiceEndpoint = { kind: "server", token: options.deviceToken };
  const reply = await options.client.health(endpoint, null, undefined, options.media);
  if (!reply.ok) {
    if (!reply.reached) {
      return { ok: false, problem: "offline" };
    }
    // Der Server antwortet im Fehlerformat: Er ist da, nur sein Druckdienst nicht (503, solange er
    // nicht läuft). Ein abgelehntes Token heißt dagegen: Das Gerät ist abgemeldet.
    return reply.code === "unauthorized" ? { ok: false, problem: "offline", unauthorized: true } : { ok: false, problem: "unavailable" };
  }
  // Am Server heißt ein Drucker im Dienst wie seine `Printer.id`.
  const service = reply.value.printers.find((candidate) => candidate.name === printer.id) ?? null;
  return {
    ok: true,
    connection: { printer, endpoint, url: null, health: reply.value, queue: printer.id, service },
    problem: service ? null : "unknown_printer",
  };
}

async function connectDirect(printer: Printer, options: ConnectOptions): Promise<ConnectResult> {
  const direct = printer.direct;
  if (!direct) {
    return { ok: false, problem: "unreachable" };
  }
  if (!options.secureContext) {
    // Ohne sicheren Kontext gibt es weder WebCrypto für den Nachweis noch die Erlaubnis.
    return { ok: false, problem: "insecure_context" };
  }
  let denied = false;
  let waiting = false;
  let answered: PrinterProblem | null = null;
  const startedAt = Date.now();
  for (const raw of direct.urls) {
    const base = baseOf(raw);
    const space = addressSpaceOf(base);
    const permission = await options.readPermission(space);
    if (permission === "denied") {
      denied = true;
      continue;
    }
    const mayPrompt = permission === "prompt" && !options.promptFree(space);
    if (mayPrompt && !options.manual) {
      waiting = true;
      continue;
    }
    const endpoint: ServiceEndpoint = { kind: "direct", base, token: direct.token };
    const nonce = newNonce();
    // Kann diese Anfrage die Nachfrage des Browsers auslösen, bekommt der Anwender Zeit für seine Antwort.
    const reply = await options.client.health(endpoint, nonce, healthTimeout(mayPrompt, startedAt, Date.now()), options.media);
    if (permission === "prompt" && (reply.ok || reply.reached) && (await options.readPermission(space)) === "prompt") {
      // Beantwortet, ohne dass der Browser gefragt hätte: In diesem Adressraum fragt er nicht.
      options.learnPromptFree(space);
    }
    if (reply.ok) {
      const proof = await proofOf(direct.token, nonce);
      if (proof === null) {
        return { ok: false, problem: "insecure_context" };
      }
      if (reply.value.app !== PRINT_SERVICE_APP || !sameProof(proof, reply.value.proof)) {
        // Es antwortet etwas, aber kein Stowly-Druckdienst mit diesem Token.
        answered ??= "not_verified";
        continue;
      }
      // Der Standarddrucker des Dienstes ist der erste in seiner Liste.
      const service = (direct.printer === null ? reply.value.printers[0] : reply.value.printers.find((candidate) => candidate.name === direct.printer)) ?? null;
      return {
        ok: true,
        connection: { printer, endpoint, url: base, health: reply.value, queue: direct.printer, service },
        problem: service ? null : "unknown_printer",
      };
    }
    if (reply.reached) {
      answered ??= "not_verified";
      continue;
    }
    // Keine Antwort. Hat der Anwender die Nachfrage eben abgelehnt?
    if ((await options.readPermission(space)) === "denied") {
      denied = true;
      continue;
    }
    if (reply.timedOut) {
      // Bis zur Zeitgrenze kam nichts: Dort ist niemand (falsches WLAN), oder der Browser wartet
      // noch auf die Antwort des Anwenders auf seine Nachfrage. Eine zweite Anfrage ohne CORS
      // kostete nur Zeit und könnte die Nachfrage ein zweites Mal auslösen. Erteilt der
      // Anwender die Erlaubnis danach, stellt der Kern von selbst zu (src/core/index.ts).
      continue;
    }
    // Die Anfrage scheiterte sofort. Ist dort überhaupt etwas? Dann fehlt nur der Ursprung der
    // App in der Konfiguration des Dienstes.
    if (await options.client.respondsWithoutCors(base)) {
      answered ??= "blocked";
    }
  }
  if (denied) {
    return { ok: false, problem: "permission" };
  }
  if (answered) {
    return { ok: false, problem: answered };
  }
  return waiting ? { ok: false, problem: "unreachable", waiting_for_permission: true } : { ok: false, problem: "unreachable" };
}

/** Nimmt die Verbindung zum Druckdienst dieses Druckers auf. Wirft nicht. */
export function connect(printer: Printer, options: ConnectOptions): Promise<ConnectResult> {
  return printer.connection === "server" ? connectServer(printer, options) : connectDirect(printer, options);
}
