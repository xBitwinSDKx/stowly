/**
 * Druckdienste im Test (docs/etiketten.md, Abschnitt 5):
 *
 * - der eigenständige Druckdienst (`python -m stowly_print serve`), wie er auf dem Raspberry Pi
 *   läuft, als eigener Prozess mit dem Bild-Treiber: freier Port, nur HTTP auf 127.0.0.1,
 *   eigenes Verzeichnis für die Etiketten, Auftragsspeicher im Arbeitsspeicher (jeder Start ein
 *   neuer Lauf mit neuer `boot_id`);
 * - der Druckdienst im Server unter `/print`: Drucker mit Bild-Treiber schreiben ihre Etiketten
 *   nach `<Datenverzeichnis>/print/images`.
 *
 * Gezählt wird am Bild-Verzeichnis: Jeder Druck ist eine Datei `<Auftrag>.png`. Steht ein
 * Auftrag dort nicht, wurde er nicht gedruckt; eine zweite Datei desselben Auftrags gibt es nicht
 * (`<Auftrag>.2.png` hieße zwei Exemplare). Gestört wird der Bild-Treiber über `simulate.txt` im
 * selben Verzeichnis (`hang`, `abort`, `fail:<code>`), ohne Neustart.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { inject } from "vitest";

import type { ServiceHealth } from "@/contract";

import { killTree } from "./process";
import { freePort, isListening, pythonPath, sleep, type ServerHandle } from "./server";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/** Das Token des Druckdienstes im Test (mindestens 16 Zeichen, sonst startet er nicht). */
export const PRINT_TOKEN = "e2e-druckdienst-0123456789";
/** Name des einen Druckers im Dienst; er ist der Standarddrucker. */
export const PRINTER_NAME = "bild";

/** Wie sich der Bild-Treiber verhalten soll; null = normal. */
export type Simulation = "hang" | "abort" | `fail:${string}` | null;

/** Kennungen der Aufträge, deren Bild in diesem Verzeichnis liegt, sortiert. */
export function printedIn(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".png"))
    .map((name) => name.slice(0, -".png".length))
    .sort();
}

/** Stört den Bild-Treiber, der in dieses Verzeichnis schreibt, oder hebt die Störung auf. */
export function simulateIn(directory: string, mode: Simulation): void {
  const file = join(directory, "simulate.txt");
  if (mode === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(directory, { recursive: true });
  // Über eine Zwischendatei: Läse der Treiber eine halb geschriebene Datei, sähe er keinen Schalter.
  const temp = join(directory, "simulate.neu");
  writeFileSync(temp, mode, "utf8");
  renameSync(temp, file);
}

/** Das Bild-Verzeichnis der Drucker am Server (stowly/printing.py). */
export function serverImageDir(server: ServerHandle): string {
  return join(server.dataDir, "print", "images");
}

export interface PrintServiceHandle {
  /** Adresse ohne Schrägstrich am Ende, z. B. "http://127.0.0.1:53124". */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Wohin der Bild-Treiber schreibt. */
  readonly imageDir: string;
  readonly running: boolean;
  /** Kennungen der gedruckten Aufträge (Bilder im Verzeichnis), sortiert. */
  printed(): string[];
  simulate(mode: Simulation): void;
  /** `GET /v1/health` ohne Nachweis, wie ihn die Seite `/p` stellt. */
  health(): Promise<ServiceHealth>;
  /** Startet den Dienst (wieder): ein neuer Lauf, derselbe Port, dasselbe Bild-Verzeichnis. */
  start(): Promise<void>;
  /** Beendet den Prozess hart, wie ein Stromausfall am Pi. */
  stop(): Promise<void>;
  output(): string;
  /** Beendet den Prozess und löscht das Verzeichnis. */
  dispose(): Promise<void>;
}

export interface PrintServiceOptions {
  /** Ursprünge der App, die direkt drucken dürfen. */
  origins?: string[];
}

const running = new Set<ChildProcess>();
let exitHookInstalled = false;
let serviceCount = 0;

/** Startet den eigenständigen Druckdienst mit einem Drucker am Bild-Treiber. */
export async function startPrintService(options: PrintServiceOptions = {}): Promise<PrintServiceHandle> {
  const python = pythonPath();
  serviceCount += 1;
  const home = mkdtempSync(join(inject("runDir"), `print-${process.pid}-${serviceCount}-`));
  const imageDir = join(home, "etiketten");
  const pidFile = `${home}.pid`;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const origins = (options.origins ?? []).map((origin) => JSON.stringify(origin)).join(", ");
  writeFileSync(
    join(home, "stowly-print.toml"),
    [
      `token = ${JSON.stringify(PRINT_TOKEN)}`,
      `origins = [${origins}]`,
      'log_level = "warning"',
      "",
      "[http]",
      'host = "127.0.0.1"',
      `port = ${String(port)}`,
      "",
      "[[printers]]",
      `name = ${JSON.stringify(PRINTER_NAME)}`,
      'driver = "image"',
      'directory = "etiketten"',
      "",
    ].join("\n"),
    "utf8",
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("STOWLY_")) {
      env[key] = entry;
    }
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONIOENCODING = "utf-8";

  const lines: string[] = [];
  let child: ChildProcess | null = null;
  const isRunning = () => child !== null && child.exitCode === null && child.signalCode === null;

  async function health(): Promise<ServiceHealth> {
    const response = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      throw new Error(`Druckdienst antwortet mit ${response.status}`);
    }
    return (await response.json()) as ServiceHealth;
  }

  async function start(): Promise<void> {
    if (isRunning()) {
      throw new Error("Der Druckdienst läuft schon.");
    }
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on("exit", () => {
        for (const service of running) {
          killTree(service.pid);
        }
      });
    }
    const started = spawn(python, ["-P", "-m", "stowly_print", "serve", "--config", "stowly-print.toml"], {
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
    if (started.pid !== undefined) {
      writeFileSync(pidFile, String(started.pid), "utf8");
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (started.exitCode !== null || started.signalCode !== null) {
        throw new Error(`Der Druckdienst hat sich beim Start beendet (Code ${String(started.exitCode)}).\n${lines.join("")}`);
      }
      try {
        if ((await health()).app === "stowly-print") {
          return;
        }
      } catch {
        // noch nicht bereit
      }
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`Der Druckdienst hat nach ${START_TIMEOUT_MS / 1000} s nicht geantwortet.\n${lines.join("")}`);
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
      // Hart, auf jedem System: Auf dem Pi stirbt der Dienst mit dem Strom.
      killTree(current.pid);
      await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
    }
    running.delete(current);
    rmSync(pidFile, { force: true });
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (await isListening(port)) {
      if (Date.now() > deadline) {
        throw new Error(`Der Druckdienst auf Port ${port} ließ sich nicht beenden.`);
      }
      await sleep(100);
    }
  }

  async function dispose(): Promise<void> {
    await stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }

  const handle: PrintServiceHandle = {
    url,
    port,
    token: PRINT_TOKEN,
    imageDir,
    get running() {
      return isRunning();
    },
    printed: () => printedIn(imageDir),
    simulate: (mode) => simulateIn(imageDir, mode),
    health,
    start,
    stop,
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
