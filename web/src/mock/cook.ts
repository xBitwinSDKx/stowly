/**
 * Vorschläge von Claude in der Attrappe (seit 0.6.0; docs/plan-0.6.md, 3): drei Beispielideen, die zu
 * den Beispieldaten passen (src/mock/sample.ts), und die Sätze, mit denen Anthropic und der Server
 * antworten.
 *
 * Wie beim Server nennen die Ideen nur Produkte, die im Bestand sind, mit ihrem Namen in Stowly. Fehlt
 * einer Idee jedes ihrer Produkte (eigene Daten, großer Bestand), nimmt sie die ersten Produkte des
 * Bestands. Ideen mit den gewählten Zutaten (`focus`) stehen vorn.
 */
import { productTitle, type AiCheckState, type CookFailure, type CookIdea, type CookIdeas, type CookProblem, type Package, type Product } from "@/contract";

/** So viele Anfragen am Tag lässt der Server zu (`AI_DAILY_MAX`). */
export const MOCK_AI_DAILY_MAX = 20;
/** Höchstens so viele Produkte gehen an Claude (`COOK_STOCK_MAX`). */
const STOCK_MAX = 300;

/** Der Satz des Servers, wenn der Schlüssel nach einem Zurückspielen fehlt (docs/plan-0.6.md, 2.2). */
export const AI_KEY_LOST = "Der API-Schlüssel für die KI-Vorschläge fehlt (steht in keiner Sicherung); bitte neu eintragen.";

interface IdeaSeed {
  title: string;
  summary: string;
  minutes: number | null;
  /** Namen der Produkte in den Beispieldaten. */
  uses: string[];
  missing: string[];
  steps: string[];
  search: string;
}

const SEEDS: readonly IdeaSeed[] = [
  {
    title: "Spaghetti mit Tomaten-Butter-Soße",
    summary: "Passierte Tomaten mit einem Stück Butter sanft eingekocht: mild, sämig und in einer halben Stunde fertig.",
    minutes: 25,
    uses: ["Spaghetti", "Passierte Tomaten", "Butter"],
    missing: ["Zwiebel", "Parmesan"],
    steps: [
      "Die Zwiebel halbieren und mit den passierten Tomaten und der Butter 20 Minuten leise köcheln lassen.",
      "Die Spaghetti in Salzwasser bissfest kochen.",
      "Die Zwiebel herausnehmen, die Soße salzen und mit den Spaghetti mischen; Parmesan darüber.",
    ],
    search: "Tomatensoße Butter",
  },
  {
    title: "Lachs mit Erbsenreis",
    summary: "Lachsfilet aus dem Ofen auf Basmatireis mit Erbsen und Butter; die Zitrone macht es frisch.",
    minutes: 30,
    uses: ["Lachsfilet (TK)", "Erbsen (TK)", "Basmati Reis", "Butter"],
    missing: ["Zitrone", "Dill"],
    steps: [
      "Den Lachs auftauen lassen und den Ofen auf 180 °C vorheizen.",
      "Den Reis kochen; in den letzten fünf Minuten die Erbsen dazugeben.",
      "Den Lachs mit Salz, Pfeffer und Zitronenscheiben 15 Minuten garen.",
      "Butter und Dill unter den Erbsenreis heben und mit dem Lachs anrichten.",
    ],
    search: "Lachs Erbsen Reis",
  },
  {
    title: "Haferflocken-Crumble mit Apfelmus",
    summary: "Knusprige Streusel aus Haferflocken, Mehl und Butter über warmem Apfelmus. Die abgelaufenen Haferflocken vorher prüfen.",
    minutes: 35,
    uses: ["Haferflocken", "Weizenmehl Type 405", "Butter", "Apfelmus"],
    missing: ["Zucker", "Zimt"],
    steps: [
      "Haferflocken, Mehl, Zucker, Zimt und kalte Butter zu Streuseln verkneten.",
      "Das Apfelmus in eine Auflaufform geben und die Streusel darauf verteilen.",
      "Bei 180 °C etwa 25 Minuten backen, bis die Streusel goldbraun sind.",
    ],
    search: "Crumble Haferflocken",
  },
];

/** Die Produkte im Bestand mit Namen, in der Reihenfolge der Produkte. */
function stockedProducts(products: readonly Product[], packages: readonly Package[]): Product[] {
  const stocked = new Set(packages.filter((pkg) => pkg.removed_at === null).map((pkg) => pkg.product_id));
  return products.filter((product) => product.deleted_at === null && product.merged_into === null && stocked.has(product.id) && product.name.trim() !== "");
}

/** Gibt es im Bestand ein Produkt mit Namen? Ohne eines antwortet der Server mit 409. */
export function hasNamedStock(products: readonly Product[], packages: readonly Package[]): boolean {
  return stockedProducts(products, packages).length > 0;
}

/**
 * Das Ergebnis eines Auftrags in der Attrappe: die Beispielideen mit den Produkten des Bestands.
 * @param focus die gewählten Zutaten: Ideen mit ihnen stehen vorn
 * @param model das Modell, das „geantwortet hat"
 */
export function mockCookIdeas(products: readonly Product[], packages: readonly Package[], focus: readonly string[], model: string): CookIdeas {
  const stocked = stockedProducts(products, packages);
  const byName = new Map(stocked.map((product) => [product.name, product]));
  const ideas: CookIdea[] = SEEDS.map((seed, index) => {
    let used = seed.uses.map((name) => byName.get(name)).filter((product): product is Product => product !== undefined);
    if (used.length === 0) {
      // Andere Daten: dann eben die Produkte, die vorn im Bestand stehen.
      used = stocked.slice(index, index + 2);
    }
    return {
      title: seed.title,
      summary: seed.summary,
      minutes: seed.minutes,
      uses: used.map((product) => ({ product_id: product.id, name: productTitle(product) })),
      missing: [...seed.missing],
      steps: [...seed.steps],
      search: seed.search,
    };
  });
  const wanted = new Set(focus);
  const score = (idea: CookIdea) => idea.uses.filter((use) => wanted.has(use.product_id)).length;
  const ordered = ideas.map((idea, index) => ({ idea, index })).sort((a, b) => score(b.idea) - score(a.idea) || a.index - b.index);
  return {
    ideas: ordered.map((entry) => entry.idea),
    model,
    fallback: false,
    stock_count: Math.min(stocked.length, STOCK_MAX),
    truncated: stocked.length > STOCK_MAX,
  };
}

/** Was im fertigen Auftrag steht, wenn er scheitert: die Sätze des Servers, wie die Attrappe sie spielt. */
export function mockCookProblem(reason: CookFailure): CookProblem {
  const messages: Record<CookFailure, string> = {
    refused: "Claude hat die Anfrage abgelehnt.",
    key_rejected: "Anthropic lehnt den API-Schlüssel ab (401).",
    forbidden: "Der API-Schlüssel darf dieses Modell nicht nutzen (403).",
    billing: "Beim Konto des Schlüssels fehlt Guthaben, oder die Abrechnung ist nicht eingerichtet.",
    model_unavailable: "Das Modell gibt es für diesen Schlüssel nicht (404).",
    busy: "Anthropic bremst gerade (429).",
    unavailable: "Anthropic ist gerade überlastet (529).",
    unreachable: "Anthropic ist nicht erreichbar.",
    timeout: "Claude hat in der Zeit keine Vorschläge geliefert.",
    incomplete: "Die Antwort von Claude war unvollständig.",
    error: "Anthropic hat unerwartet geantwortet.",
  };
  return { reason, message: messages[reason], retry_after_s: reason === "busy" ? 30 : null, category: null };
}

/**
 * Was der Server gutschreibt: Anthropic hat nichts berechnet, wenn es mit einem Fehler antwortete oder
 * gar nicht erreichbar war (docs/plan-0.6.md, 2.6).
 */
export const CREDITED_FAILURES: ReadonlySet<CookFailure> = new Set<CookFailure>(["key_rejected", "forbidden", "billing", "model_unavailable", "busy", "unavailable", "unreachable"]);

/** Der Satz zu „Prüfen" je Ergebnis. */
export function mockCheckMessage(state: AiCheckState, modelName: string): string {
  switch (state) {
    case "ok":
      return `Schlüssel und Modell passen (${modelName}).`;
    case "key_rejected":
      return "Anthropic lehnt den API-Schlüssel ab.";
    case "forbidden":
      return "Der API-Schlüssel darf dieses Modell nicht nutzen.";
    case "model_unavailable":
      return `${modelName} gibt es für diesen Schlüssel nicht.`;
    case "busy":
      return "Anthropic ist gerade ausgelastet; später noch einmal prüfen.";
    case "unreachable":
      return "Anthropic ist nicht erreichbar.";
    case "error":
      return "Anthropic hat unerwartet geantwortet.";
  }
}
