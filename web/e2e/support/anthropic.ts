/**
 * Eine nachgebildete Anthropic-API als HTTP-Server unter 127.0.0.1, für die Tests der KI-Vorschläge
 * gegen den echten Stowly-Server (cook.e2e.test.ts). Der Server spricht sie über das SDK an, wenn er
 * mit `--dev` und `STOWLY_ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` läuft; ein fremder Dienst wird
 * nie gefragt.
 *
 * Sie kann, was Stowly von Anthropic braucht (server/stowly/claude.py):
 * - Den Schlüssel nimmt sie wie Anthropic als `x-api-key` oder als `Authorization: Bearer …` (so schickt
 *   ihn das SDK 2.x); ohne den richtigen antwortet jeder Aufruf 401.
 * - `GET /v1/models/{id}` (die Prüfung, kostet keine Tokens): das Modell, wenn der Schlüssel stimmt;
 *   ein unbekanntes Modell 404, ein falscher Schlüssel 401.
 * - `POST /v1/messages` (auch `?beta=true`, mit dem Ersatzmodell): eine Message, deren erster Textblock
 *   das JSON der Ideen in der Form des Ausgabe-Schemas ist, mit den Schlüsseln `P…` der Vorratsliste aus
 *   dem Prompt (`<vorrat>`, `<schwerpunkte>`).
 * - Auf Wunsch (`failure`) Fehler wie Anthropic: ein Status mit `{"type":"error","error":{…}}`, bei 429 mit
 *   `retry-after`, oder eine Ablehnung (200 mit `stop_reason: "refusal"` und `stop_details`). Fehler tragen
 *   `x-should-retry: false`: Das SDK versucht es dann nicht noch einmal, und jeder Test sieht genau eine Anfrage.
 *
 * Sie führt Buch über jede Anfrage: Methode, Pfad, ob der Schlüssel stimmte, die Kopfzeilen ohne den
 * Schlüssel und den Rumpf.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Ein Produkt der Vorratsliste, wie es im Prompt steht (`{"k":"P1","name":…}`). */
export interface PromptEntry {
  k: string;
  name: string;
  brand?: string;
  size?: string;
  count?: number;
  days?: number;
  state?: string;
}

/** Was der Prompt einer Anfrage enthält: die Vorratsliste und die Schlüssel der gewählten Zutaten. */
export interface PromptData {
  stock: PromptEntry[];
  focus: string[];
  /** Der Wunsch, wie er im Prompt steht (als JSON-Text gelesen). */
  wish: string;
}

/** Wie die nächsten Anfragen an `/v1/messages` scheitern: ein Fehler mit Status, oder eine Ablehnung. */
export type FakeAnthropicFailure = { status: number; type: string; message?: string; retryAfter?: number } | { refusal: string | null };

export interface FakeAnthropicRequest {
  method: string;
  /** Pfad ohne Abfrage, etwa "/v1/messages". */
  path: string;
  /** Die Abfrage ohne Fragezeichen, etwa "beta=true"; leer ohne. */
  query: string;
  /** Kam der richtige Schlüssel mit (`x-api-key` oder `Authorization: Bearer …`)? */
  authorized: boolean;
  /** Die Kopfzeilen mit kleingeschriebenen Namen, ohne `x-api-key` und `authorization`. */
  headers: Record<string, string>;
  /** Der Rumpf als JSON; null ohne. */
  body: Record<string, unknown> | null;
}

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Der Text der Nachricht des Anwenders (eine Zeichenkette oder Textblöcke). */
function userText(body: Record<string, unknown> | null): string {
  const messages = Array.isArray(body?.messages) ? (body.messages as { role?: unknown; content?: unknown }[]) : [];
  const user = messages.find((message) => message.role === "user");
  if (typeof user?.content === "string") {
    return user.content;
  }
  if (Array.isArray(user?.content)) {
    return (user.content as { type?: unknown; text?: unknown }[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

/** Liest Vorratsliste, Schwerpunkte und Wunsch aus dem Prompt des Servers (server/stowly/cook.py, `prompt`). */
export function readPrompt(text: string): PromptData {
  const between = (tag: string) => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    return match?.[1] ?? "";
  };
  const stock = between("vorrat")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as PromptEntry);
  const parse = <T>(raw: string, fallback: T): T => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return { stock, focus: parse<string[]>(between("schwerpunkte"), []), wish: parse<string>(between("wunsch"), "") };
}

/**
 * Die Vorgabe für die Ideen: drei Gerichte, die gewählten Zutaten zuerst, dazu ein Schlüssel, den es
 * nicht gibt (der Server lässt ihn weg), und Schritte mit Nummern (der Server nimmt sie heraus).
 */
export function defaultIdeas(prompt: PromptData): unknown {
  const keys = [...prompt.focus, ...prompt.stock.map((entry) => entry.k).filter((key) => !prompt.focus.includes(key))];
  return {
    ideas: [0, 1, 2].map((index) => ({
      title: `Gericht ${String(index + 1)}`,
      summary: "Ein Vorschlag der nachgebildeten API.",
      minutes: 20 + index * 5,
      uses: [...keys.slice(index, index + 2), "P999"],
      missing: ["Zwiebel", "Knoblauch"],
      steps: ["1. Vorbereiten.", "Kochen.", "Abschmecken."],
      search: "Resteessen",
    })),
  };
}

export class FakeAnthropic {
  /** Der Schlüssel, den diese API annimmt; für jeden Lauf neu. */
  readonly key = `sk-ant-api03-e2e-${hex(24)}`;
  /** Die Modelle, die es für diesen Schlüssel gibt. */
  readonly models = new Set(Object.keys(MODEL_NAMES));
  /** Alle Anfragen in ihrer Reihenfolge. */
  readonly requests: FakeAnthropicRequest[] = [];
  /** Wie die Anfragen an `/v1/messages` scheitern; null = sie gelingen. */
  failure: FakeAnthropicFailure | null = null;
  /** Baut das JSON der Ideen aus dem Prompt; Vorgabe `defaultIdeas`. */
  ideas: (prompt: PromptData) => unknown = defaultIdeas;
  /** So lange lässt sich die Antwort auf `/v1/messages` Zeit, in Millisekunden. */
  delayMs = 0;
  /** Adresse ohne Schrägstrich am Ende, etwa "http://127.0.0.1:53124". */
  url = "";
  private server: Server | null = null;

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => this.error(response, 500, "api_error", "Fehler in der Nachbildung"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Die Anfragen an einen Pfad (ohne Abfrage). */
  calls(path: string): FakeAnthropicRequest[] {
    return this.requests.filter((entry) => entry.path === path);
  }

  /** Der Prompt der letzten Anfrage nach Vorschlägen. */
  lastPrompt(): PromptData {
    const last = this.calls("/v1/messages").at(-1);
    if (!last) {
      throw new Error("Es kam noch keine Anfrage nach Vorschlägen.");
    }
    return readPrompt(userText(last.body));
  }

  private send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { "content-type": "application/json", "request-id": `req_${hex(12)}`, ...headers });
    response.end(JSON.stringify(body));
  }

  private error(response: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
    this.send(response, status, { type: "error", error: { type, message }, request_id: `req_${hex(12)}` }, { "x-should-retry": "false", ...headers });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const [path = "", query = ""] = (request.url ?? "").split("?");
    const method = request.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name !== "x-api-key" && name !== "authorization" && typeof value === "string") {
        headers[name] = value;
      }
    }
    // Das SDK 2.x schickt den Schlüssel als `Authorization: Bearer …`; `x-api-key` gilt als Rückfall.
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice("Bearer ".length) : undefined;
    const authorized = (bearer ?? request.headers["x-api-key"]) === this.key;
    const raw = method === "POST" ? await readBody(request) : "";
    let body: Record<string, unknown> | null = null;
    try {
      body = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      body = null;
    }
    this.requests.push({ method, path, query, authorized, headers, body });

    if (!authorized) {
      this.error(response, 401, "authentication_error", "invalid x-api-key");
      return;
    }
    const model = /^\/v1\/models\/([^/]+)$/.exec(path);
    if (method === "GET" && model) {
      const id = decodeURIComponent(model[1] ?? "");
      if (!this.models.has(id)) {
        this.error(response, 404, "not_found_error", `model: ${id}`);
        return;
      }
      this.send(response, 200, { type: "model", id, display_name: MODEL_NAMES[id] ?? id, created_at: "2026-10-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 });
      return;
    }
    if (method === "POST" && path === "/v1/messages") {
      await this.messages(response, body);
      return;
    }
    this.error(response, 404, "not_found_error", "Not found");
  }

  private async messages(response: ServerResponse, body: Record<string, unknown> | null): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const model = typeof body?.model === "string" ? body.model : "";
    if (!this.models.has(model)) {
      this.error(response, 404, "not_found_error", `model: ${model}`);
      return;
    }
    const failure = this.failure;
    if (failure !== null && "status" in failure) {
      this.error(response, failure.status, failure.type, failure.message ?? failure.type, failure.retryAfter === undefined ? {} : { "retry-after": String(failure.retryAfter) });
      return;
    }
    const usage = { input_tokens: 1_234, output_tokens: 567, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" };
    const message = { id: `msg_${hex(12)}`, type: "message", role: "assistant", model, stop_sequence: null, usage };
    if (failure !== null) {
      this.send(response, 200, {
        ...message,
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: failure.refusal, explanation: "Die Nachbildung lehnt ab." },
      });
      return;
    }
    const ideas = this.ideas(readPrompt(userText(body)));
    this.send(response, 200, { ...message, content: [{ type: "text", text: JSON.stringify(ideas) }], stop_reason: "end_turn", stop_details: null });
  }
}
