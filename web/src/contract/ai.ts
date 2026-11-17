/**
 * KI-Vorschläge (seit 0.6.0; docs/plan-0.6.md, 3): die Vorprüfung der Eingaben, gemeinsam für den Kern
 * (src/core/ai.ts), die Attrappe und das Formular in den Einstellungen (wie input.ts).
 *
 * Der API-Schlüssel nach denselben Regeln wie am Server: an den Rändern gekürzt, druckbares ASCII ohne
 * Leerraum, beginnt mit `sk-ant-`, kein Admin-Schlüssel (`sk-ant-admin…`), höchstens `LIMITS.ai_key`
 * Zeichen. Was hier durchgeht, lehnt der Server nicht wegen der Form ab; ob Anthropic den Schlüssel
 * kennt, sagt erst `ai.check`. Kein Satz wiederholt den Schlüssel oder einen Teil davon.
 *
 * Bewusst nicht in index.ts: Nur nachgeladene Teile brauchen das, das Hauptpaket nicht. Importiert
 * wird es als "@/contract/ai".
 */
import { LIMITS, type CookIdeasInput } from "./api.gen";
import { CoreError } from "./errors";
import { isUuid } from "./ids";

/** So beginnt jeder API-Schlüssel von Anthropic. */
export const AI_KEY_PREFIX = "sk-ant-";
/** So beginnt ein Admin-Schlüssel: Er verwaltet die Organisation und taugt nicht für Anfragen. */
export const AI_ADMIN_KEY_PREFIX = "sk-ant-admin";

/** Druckbares ASCII ohne Leerzeichen: `!` bis `~`. */
const PRINTABLE = /^[\x21-\x7e]+$/;

function invalidKey(message: string): CoreError {
  return new CoreError("invalid", message, { errors: [{ loc: ["body", "key"], msg: message, type: "value_error" }] });
}

/**
 * Prüft einen API-Schlüssel von Anthropic vorab, wie der Server es tut, und liefert ihn ohne Leerraum
 * am Rand. Scheitert mit "invalid" und `details.errors` an `["body","key"]`.
 */
export function checkAiKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key === "") {
    throw invalidKey("Bitte den API-Schlüssel von Anthropic einfügen (er beginnt mit sk-ant-).");
  }
  if (key.length > LIMITS.ai_key) {
    throw invalidKey(`Der Schlüssel ist zu lang (höchstens ${String(LIMITS.ai_key)} Zeichen).`);
  }
  if (!PRINTABLE.test(key) || !key.startsWith(AI_KEY_PREFIX)) {
    throw invalidKey("Ein API-Schlüssel von Anthropic beginnt mit sk-ant- und enthält weder Leerzeichen noch Umlaute.");
  }
  if (key.startsWith(AI_ADMIN_KEY_PREFIX)) {
    throw invalidKey("Das ist ein Admin-Schlüssel. Stowly braucht einen gewöhnlichen API-Schlüssel (sk-ant-api…).");
  }
  return key;
}

function invalidField(field: string, message: string): CoreError {
  return new CoreError("invalid", message, { errors: [{ loc: ["body", field], msg: message, type: "value_error" }] });
}

/**
 * Die Eingabe eines Auftrags (`ai.start`), wie sie hinausgeht: der Wunsch an den Rändern gekürzt, die
 * Zutaten ohne Doppelte. Scheitert mit "invalid", wo der Server ablehnen würde: ein Wunsch über
 * `LIMITS.cook_wish` Zeichen, mehr als `LIMITS.cook_focus` Zutaten, eine Zutat ohne gültige Kennung.
 */
export function checkCookInput(input: CookIdeasInput | undefined): Required<CookIdeasInput> {
  const wish = typeof input?.wish === "string" ? input.wish.trim() : "";
  if (wish.length > LIMITS.cook_wish) {
    throw invalidField("wish", `Der Wunsch ist zu lang (höchstens ${String(LIMITS.cook_wish)} Zeichen).`);
  }
  const focus = [...new Set(Array.isArray(input?.focus) ? input.focus : [])];
  if (focus.length > LIMITS.cook_focus) {
    throw invalidField("focus", `Höchstens ${String(LIMITS.cook_focus)} Zutaten.`);
  }
  if (!focus.every((id) => typeof id === "string" && isUuid(id))) {
    throw invalidField("focus", "Eine Zutat ist kein Produkt aus dem Bestand.");
  }
  return { wish, focus };
}
