/**
 * Läuft einmal vor allen Testdateien und einmal danach.
 *
 * Davor: legt das gemeinsame temporäre Verzeichnis an. Darin liegen die Datenverzeichnisse
 * aller Server dieses Laufs und je laufendem Server eine Datei mit seiner Prozessnummer.
 *
 * Danach: beendet jeden Server, dessen Testdatei das nicht mehr selbst geschafft hat
 * (abgestürzter Testprozess), und löscht das Verzeichnis.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestProject } from "vitest/node";

import { isPythonProcess, killTree } from "./process";

export default function setup(project: TestProject): () => void {
  const runDir = mkdtempSync(join(tmpdir(), "stowly-e2e-"));
  project.provide("runDir", runDir);

  return () => {
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith(".pid")) {
        continue;
      }
      const pid = Number(readFileSync(join(runDir, name), "utf8").trim());
      if (isPythonProcess(pid)) {
        killTree(pid);
      }
    }
    // Unter Windows gibt ein eben beendeter Prozess seine Dateien nicht sofort frei.
    rmSync(runDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    /** Temporäres Verzeichnis dieses Testlaufs. */
    runDir: string;
  }
}
