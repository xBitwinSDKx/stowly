/**
 * Startet den echten Stowly-Server als eigenen Prozess.
 *
 *   python -P -m stowly --dev --port <frei>        (`dev: false` lässt `--dev` weg)
 *
 * - Python: die Umgebungsvariable STOWLY_E2E_PYTHON, sonst das aus `.venv` im Repository
 *   (`.venv\Scripts\python.exe` unter Windows, `.venv/bin/python` sonst).
 * - Port: ein freier, vom Betriebssystem vergeben; nie 8010 bis 8013 (die gehören den
 *   Starteinträgen beim Entwickeln).
 * - Daten: ein eigenes Verzeichnis unter dem temporären Verzeichnis des Testlaufs.
 * - Open Food Facts ist ausgeschaltet. Der eine Test, der das Nachschlagen prüft, schaltet es
 *   ein und lenkt es auf einen Ersatz unter 127.0.0.1 um (STOWLY_OFF_URL, lookup.e2e.test.ts).
 *   Kein Test ruft einen fremden Dienst auf.
 * - Passwort: das Entwicklungs-Passwort von `--dev` (`PASSWORD` in device.ts).
 *
 * Wer `startServer` ruft, ruft am Ende `dispose()` (in `afterAll`). Scheitert das, räumen
 * der Prozess selbst (Ereignis "exit") und zuletzt global-setup.ts auf.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { inject } from "vitest";

import { killTree } from "./process";

/** Wurzel des Repositorys (web/e2e/support liegt drei Ebenen darunter). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const START_TIMEOUT_MS = 40_000;
const STOP_TIMEOUT_MS = 10_000;
/** Ports der Starteinträge beim Entwickeln; ein Test belegt sie nie. */
const RESERVED_PORTS = new Set([8010, 8011, 8012, 8013]);

export interface ServerOptions {
  /** Zusätzliche Umgebungsvariablen für den Server. */
  env?: Record<string, string>;
  /** false: ohne `--dev`, also ohne das Entwicklungs-Passwort. Vorgabe true. */
  dev?: boolean;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ServerHandle {
  /** Adresse ohne Schrägstrich am Ende, z. B. "http://127.0.0.1:53124". */
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  readonly running: boolean;
  /** Startet den Server (wieder), mit demselben Port und demselben Datenverzeichnis. */
  start(): Promise<void>;
  /** Beendet den Prozess. Port und Daten bleiben für `start()`. */
  stop(): Promise<void>;
  /** `python -P -m stowly <args>` gegen dasselbe Datenverzeichnis, ohne den Server zu starten. */
  cli(args: readonly string[]): CliResult;
  /** Alles, was der Server bisher ausgegeben hat. */
  output(): string;
  /** Beendet den Prozess und löscht das Datenverzeichnis. */
  dispose(): Promise<void>;
}

function pythonPath(): string {
  const configured = process.env.STOWLY_E2E_PYTHON?.trim();
  if (configured) {
    return configured;
  }
  const fallback = process.platform === "win32" ? join(REPO_ROOT, ".venv", "Scripts", "python.exe") : join(REPO_ROOT, ".venv", "bin", "python");
  if (!existsSync(fallback)) {
    throw new Error(
      `Kein Python für den Server gefunden (${fallback}). Lege die Umgebung an (README.md, „Entwickeln") ` +
        "oder setze STOWLY_E2E_PYTHON auf ein Python, in dem der Server installiert ist.",
    );
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Wahr, wenn auf dem Port jemand Verbindungen annimmt. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Die Umgebung des Servers: nichts von dem, was beim Entwickler zufällig gesetzt ist. */
function serverEnv(dataDir: string, webDir: string, extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("STOWLY_")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    STOWLY_DATA_DIR: dataDir,
    // Ein leeres Verzeichnis: Der Server liefert nur die Schnittstelle, gleich ob web/dist gebaut ist.
    STOWLY_WEB_DIR: webDir,
    STOWLY_OFF_ENABLED: "0",
    STOWLY_HOST: "127.0.0.1",
    STOWLY_LOG_LEVEL: "warning",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
}

/** Laufende Server dieses Testprozesses; endet der Prozess, enden sie mit. */
const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const child of running) {
      killTree(child.pid);
    }
  });
}

let serverCount = 0;

export async function startServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const python = pythonPath();
  const runDir = inject("runDir");
  serverCount += 1;
  const home = mkdtempSync(join(runDir, `server-${process.pid}-${serverCount}-`));
  const dataDir = join(home, "data");
  const webDir = join(home, "web");
  mkdirSync(dataDir);
  mkdirSync(webDir);
  const pidFile = `${home}.pid`;

  let port = await freePort();
  while (RESERVED_PORTS.has(port)) {
    port = await freePort();
  }
  const url = `http://127.0.0.1:${port}`;
  const env = serverEnv(dataDir, webDir, options.env);
  // Sicherung: Ein Test darf das Nachschlagen nur gegen einen Ersatz auf diesem Rechner einschalten.
  if (env.STOWLY_OFF_ENABLED !== "0" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(env.STOWLY_OFF_URL ?? "")) {
    throw new Error("Open Food Facts darf in Tests nur mit STOWLY_OFF_URL=http://127.0.0.1:<port> eingeschaltet werden.");
  }
  const lines: string[] = [];
  let child: ChildProcess | null = null;

  const isRunning = () => child !== null && child.exitCode === null && child.signalCode === null;

  async function start(): Promise<void> {
    if (isRunning()) {
      throw new Error("Der Server läuft schon.");
    }
    installExitHook();
    const started = spawn(python, ["-P", "-m", "stowly", ...(options.dev === false ? [] : ["--dev"]), "--port", String(port)], {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = started;
    running.add(started);
    started.stdout?.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));
    started.stderr?.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));
    started.once("exit", () => running.delete(started));
    let spawnError: Error | null = null;
    started.once("error", (error) => {
      spawnError = error;
    });
    if (started.pid !== undefined) {
      writeFileSync(pidFile, String(started.pid), "utf8");
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (spawnError !== null) {
        throw new Error(`Der Server ließ sich nicht starten (${python}): ${String(spawnError)}`);
      }
      if (started.exitCode !== null || started.signalCode !== null) {
        throw new Error(`Der Server hat sich beim Start beendet (Code ${String(started.exitCode)}).\n${lines.join("")}`);
      }
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
        const body = (await response.json()) as { app?: unknown };
        if (response.ok && body.app === "stowly") {
          return;
        }
      } catch {
        // noch nicht bereit
      }
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`Der Server hat nach ${START_TIMEOUT_MS / 1000} s nicht geantwortet.\n${lines.join("")}`);
      }
      await sleep(100);
    }
  }

  async function stop(): Promise<void> {
    const current = child;
    child = null;
    if (current === null) {
      return;
    }
    if (current.exitCode === null && current.signalCode === null) {
      const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
      if (process.platform === "win32") {
        killTree(current.pid);
      } else {
        // Erst höflich: uvicorn fährt dann geordnet herunter.
        current.kill("SIGTERM");
      }
      const force = setTimeout(() => killTree(current.pid), STOP_TIMEOUT_MS / 2);
      await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
      clearTimeout(force);
    }
    running.delete(current);
    rmSync(pidFile, { force: true });
    // Erst wenn niemand mehr auf dem Port hört, ist der Server wirklich weg.
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (await isListening(port)) {
      if (Date.now() > deadline) {
        throw new Error(`Der Server auf Port ${port} ließ sich nicht beenden.`);
      }
      await sleep(100);
    }
  }

  function cli(args: readonly string[]): CliResult {
    const result = spawnSync(python, ["-P", "-m", "stowly", ...args], { cwd: home, env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async function dispose(): Promise<void> {
    await stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }

  const handle: ServerHandle = {
    url,
    port,
    dataDir,
    get running() {
      return isRunning();
    },
    start,
    stop,
    cli,
    output: () => lines.join(""),
    dispose,
  };
  try {
    await start();
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return handle;
}
