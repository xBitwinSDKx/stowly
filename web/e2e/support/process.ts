/**
 * Prozesse beenden, so dass wirklich nichts übrig bleibt.
 *
 * Unter Windows ist `.venv\Scripts\python.exe` nur ein Starter: Der eigentliche Interpreter
 * läuft als Kindprozess und überlebt es, wenn man nur den Starter beendet. Deshalb wird dort
 * immer der ganze Prozessbaum beendet.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Beendet den Prozess `pid` samt seinen Kindern, sofort und ohne Rückfrage. Wirft nicht. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // schon beendet
  }
}

/**
 * Wahr, wenn unter dieser Prozessnummer (noch) ein Python läuft. Schützt das Aufräumen davor,
 * einen fremden Prozess zu treffen, der die Nummer inzwischen geerbt hat.
 */
export function isPythonProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      return /^"python[^"]*"/im.test(result.stdout ?? "");
    }
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("python");
  } catch {
    return false;
  }
}
