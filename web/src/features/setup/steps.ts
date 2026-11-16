/**
 * Die Schritte des Assistenten als reine Logik, ohne React: Reihenfolge, Beschriftungen, was
 * erledigt ist, wohin „Weiter" und „Zurück" führen.
 */
import type { SetupStatus, SetupStep, SetupStepId, SetupStepKey } from "@/contract";

/** Die Schritte nach dem Passwort, in der Reihenfolge des Assistenten (`SetupStepId`). */
export const WIZARD_STEPS: readonly SetupStepId[] = ["https", "printer", "backup", "updates", "notifications", "home_assistant"];

/** Beschriftungen im Fortschritt: der Zugang (das Passwort) vorweg, die Übersicht am Ende. */
export const STEP_LABELS: Readonly<Record<SetupStepKey | "access", string>> = {
  access: "Zugang",
  https: "Sichere Verbindung",
  printer: "Drucker",
  backup: "Sicherung",
  updates: "Updates",
  notifications: "Benachrichtigungen",
  home_assistant: "Home Assistant",
  done: "Fertig",
};

/** So viele Schritte zählt der Fortschritt: der Zugang und die Schritte danach; die Übersicht nicht. */
export const STEP_COUNT = WIZARD_STEPS.length + 1;

/** Wie der Assistent einen Schritt zeigt. */
export type StepProgress = "done" | "skipped" | "open";

/** Ein Schritt aus dem Stand des Servers; fehlt er dort, gilt er als offen. */
export function stepOf(status: SetupStatus, id: SetupStepId): SetupStep {
  return status.steps.find((step) => step.id === id) ?? { id, state: "open", ready: false, changed_at: null };
}

/** Erledigt: aus Sicht des Servers (`ready`) oder von der App so markiert. */
export function isStepDone(step: Pick<SetupStep, "ready" | "state">): boolean {
  return step.ready || step.state === "done";
}

/**
 * Der Stand eines Schritts. Läuft die Seite schon über HTTPS (`secure`, auch hinter einem Reverse
 * Proxy), ist die sichere Verbindung erledigt, was auch immer der Server weiß.
 */
export function progressOf(step: SetupStep, secure: boolean): StepProgress {
  if (isStepDone(step) || (step.id === "https" && secure)) {
    return "done";
  }
  return step.state === "skipped" ? "skipped" : "open";
}

/**
 * Der erste Schritt, der weder erledigt noch übersprungen ist; gibt es keinen, die Übersicht. Ist die
 * Einrichtung abgeschlossen, immer die Übersicht: Dort steht, was sich nachholen lässt, auch ein
 * Schritt, der erst mit einem Update dazukam (Sicherung, Home Assistant).
 */
export function firstOpenStep(status: SetupStatus, secure = false): SetupStepKey {
  if (status.finished_at !== null) {
    return "done";
  }
  return WIZARD_STEPS.find((id) => progressOf(stepOf(status, id), secure) === "open") ?? "done";
}

/** Wie viele der Schritte nach dem Zugang erledigt sind. */
export function doneCount(status: SetupStatus, secure = false): number {
  return WIZARD_STEPS.filter((id) => progressOf(stepOf(status, id), secure) === "done").length;
}

/** Die Nummer im Fortschritt: Der Zugang ist 1, die Schritte ab 2, die Übersicht wie der letzte. */
export function stepNumber(key: SetupStepKey): number {
  return key === "done" ? STEP_COUNT : WIZARD_STEPS.indexOf(key) + 2;
}

/** Wohin „Weiter" und „Überspringen" führen. */
export function nextStep(key: SetupStepKey): SetupStepKey {
  return key === "done" ? "done" : (WIZARD_STEPS[WIZARD_STEPS.indexOf(key) + 1] ?? "done");
}

/** Wohin „Zurück" führt; null vor dem ersten Schritt (dort gibt es kein Zurück). */
export function previousStep(key: SetupStepKey): SetupStepKey | null {
  const index = key === "done" ? WIZARD_STEPS.length : WIZARD_STEPS.indexOf(key);
  return WIZARD_STEPS[index - 1] ?? null;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Ist `version` älter als `than`? Verglichen werden die drei Zahlen; was keine Version wie 1.2.3 ist, gilt nie als älter. */
export function isOlderVersion(version: string | null | undefined, than: string): boolean {
  const a = VERSION.exec(version ?? "");
  const b = VERSION.exec(than);
  if (!a || !b) {
    return false;
  }
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}
