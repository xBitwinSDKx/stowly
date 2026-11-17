/**
 * Sätze zu den Vorschlägen von Claude (docs/plan-0.6.md, 3): Namen der Modelle, Wartezeiten und was
 * die Seite sagt, wenn ein Auftrag nicht startet oder scheitert. Reine Logik ohne React; auch die
 * Einstellungen nehmen die Namen der Modelle von hier.
 */
import { AI_DEVICE_GAP_S, isCoreError, type AiModel, type CookFailure, type CookProblem } from "@/contract";
import { errorText } from "@/ui";

/** Die wählbaren Modelle mit dem, was sie auszeichnet (docs/plan-0.6.md, „Kosten"). */
export const AI_MODEL_OPTIONS: readonly { value: AiModel; name: string; hint: string }[] = [
  { value: "claude-opus-5-5", name: "Claude Opus 5.5", hint: "beste Vorschläge, etwa 7 Cent je Anfrage" },
  { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", hint: "etwa halb so teuer" },
  { value: "claude-haiku-5-5", name: "Claude Haiku 5.5", hint: "unter einem Cent je Anfrage" },
];

/**
 * Der Name eines Modells zum Anzeigen: „Claude Opus 5.5". Auch ein Ersatzmodell, das die App nicht
 * kennt („claude-opus-4-8" wird „Claude Opus 4.8"); was nicht so aussieht, bleibt, wie es ist.
 */
export function modelName(model: string): string {
  const known = AI_MODEL_OPTIONS.find((option) => option.value === model);
  if (known) {
    return known.name;
  }
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!parts?.[1] || !parts[2]) {
    return model;
  }
  const family = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
  return `Claude ${family} ${parts[2]}${parts[3] === undefined ? "" : `.${parts[3]}`}`;
}

/** Eine Wartezeit in Worten: „in 25 Sekunden", „in einer Minute", „in 3 Stunden". */
export function waitText(seconds: number): string {
  const value = Math.max(1, Math.ceil(seconds));
  if (value <= 90) {
    return value === 1 ? "in einer Sekunde" : `in ${String(value)} Sekunden`;
  }
  if (value < 5_400) {
    const minutes = Math.ceil(value / 60);
    return minutes === 1 ? "in einer Minute" : `in ${String(minutes)} Minuten`;
  }
  const hours = Math.ceil(value / 3_600);
  return hours === 1 ? "in einer Stunde" : `in ${String(hours)} Stunden`;
}

/** Was die Seite zu einem Fehlschlag sagt: Überschrift, Satz, und ob der Weg in die Einstellungen hilft. */
export interface CookNotice {
  title: string;
  text: string;
  /** Der Weg führt über die Einstellungen (Schlüssel, Guthaben, Modell). */
  settings: boolean;
  /** Ein Satz, wann es wieder geht: kein „Noch einmal" vorher. */
  later: boolean;
}

/** Der Satz zu einem gescheiterten Auftrag (`CookJob.problem`), je Grund. */
export function failureNotice(problem: Pick<CookProblem, "reason" | "retry_after_s" | "message">): CookNotice {
  const again =
    problem.retry_after_s !== null && problem.retry_after_s > 0
      ? `Bitte später noch einmal versuchen, frühestens ${waitText(problem.retry_after_s)}.`
      : "Bitte später noch einmal versuchen.";
  const notices: Record<CookFailure, CookNotice> = {
    refused: { title: "Claude hat abgelehnt", text: "Claude hat diese Anfrage abgelehnt. Den Wunsch anders formulieren und noch einmal versuchen.", settings: false, later: false },
    key_rejected: { title: "Schlüssel abgelehnt", text: "Anthropic lehnt den API-Schlüssel ab. In den Einstellungen einen gültigen eintragen.", settings: true, later: false },
    forbidden: { title: "Nicht erlaubt", text: "Der API-Schlüssel darf das gewählte Modell nicht nutzen. In den Einstellungen den Schlüssel oder das Modell ändern.", settings: true, later: false },
    billing: { title: "Kein Guthaben", text: "Beim Konto des Schlüssels fehlt Guthaben, oder die Abrechnung ist nicht eingerichtet (console.anthropic.com).", settings: true, later: false },
    model_unavailable: { title: "Modell nicht verfügbar", text: "Das gewählte Modell steht für diesen Schlüssel nicht zur Verfügung. In den Einstellungen ein anderes wählen.", settings: true, later: false },
    busy: { title: "Anthropic bremst gerade", text: `Anthropic ist gerade ausgelastet. ${again}`, settings: false, later: true },
    unavailable: { title: "Anthropic ist überlastet", text: `Anthropic antwortet gerade nicht. ${again}`, settings: false, later: true },
    unreachable: { title: "Anthropic nicht erreichbar", text: `Der Stowly-Server erreicht Anthropic gerade nicht. ${again}`, settings: false, later: true },
    timeout: { title: "Keine Antwort in der Zeit", text: `Claude hat nicht rechtzeitig geantwortet. ${again}`, settings: false, later: true },
    incomplete: { title: "Antwort unvollständig", text: "Die Antwort von Claude kam unvollständig an. Bitte noch einmal versuchen.", settings: false, later: false },
    error: { title: "Etwas ging schief", text: `${problem.message} Bitte noch einmal versuchen.`, settings: false, later: false },
  };
  return notices[problem.reason as CookFailure] ?? notices.error;
}

/** Der Satz, wenn ein Auftrag gar nicht erst startet (`ai.start`) oder das Warten scheitert. */
export function startNotice(error: unknown, dailyLimit: number | null): CookNotice {
  if (isCoreError(error, "rate_limited")) {
    const seconds = typeof error.details.retry_after_s === "number" ? error.details.retry_after_s : null;
    const when = seconds === null ? "gleich" : waitText(seconds);
    switch (error.details.reason) {
      case "daily_limit":
        return {
          title: "Für heute ist Schluss",
          text: `Der Haushalt hat heute ${dailyLimit === null ? "alle" : `alle ${String(dailyLimit)}`} Anfragen gestellt. Morgen wieder.`,
          settings: false,
          later: true,
        };
      case "busy":
        return { title: "Gerade läuft schon eine Anfrage", text: `Ein Gerät des Haushalts wartet gerade auf Vorschläge von Claude. Noch einmal ${when}.`, settings: false, later: true };
      case "too_soon":
        return { title: "Eben erst gefragt", text: `Jedes Gerät kann alle ${String(AI_DEVICE_GAP_S)} Sekunden fragen. Noch einmal ${when}.`, settings: false, later: true };
      default:
        return { title: "Zu viele Anfragen", text: `Bitte ${when} noch einmal.`, settings: false, later: true };
    }
  }
  if (isCoreError(error, "not_configured")) {
    return error.details.reason === "lost"
      ? { title: "API-Schlüssel fehlt", text: "Der API-Schlüssel fehlt nach dem Zurückspielen einer Sicherung; er steht in keiner. In den Einstellungen neu eintragen.", settings: true, later: false }
      : { title: "Kein API-Schlüssel", text: "Für Vorschläge von Claude braucht Stowly einen API-Schlüssel von Anthropic. In den Einstellungen eintragen.", settings: true, later: false };
  }
  if (isCoreError(error, "conflict")) {
    return { title: "Nichts im Vorrat", text: "Im Bestand ist kein Produkt mit Namen: Claude hätte nichts, woraus es kochen könnte.", settings: false, later: false };
  }
  if (isCoreError(error, "not_found")) {
    return { title: "Auftrag abgelaufen", text: "Den Auftrag gibt es am Server nicht mehr. Bitte noch einmal fragen.", settings: false, later: false };
  }
  if (isCoreError(error, "offline")) {
    return { title: "Server nicht erreichbar", text: "Vorschläge von Claude gehen nur über den Stowly-Server, und der ist gerade nicht erreichbar. Die Such-Links gehen trotzdem.", settings: false, later: false };
  }
  if (isCoreError(error, "not_supported")) {
    // Ein Server vor 0.6.0 antwortet mit 501; sein Satz hilft hier nicht weiter.
    return { title: "Noch nicht verfügbar", text: "Dieser Server kennt noch keine Vorschläge von Claude. Erst Stowly aktualisieren.", settings: false, later: false };
  }
  return { title: "Das ging nicht", text: errorText(error), settings: false, later: false };
}
