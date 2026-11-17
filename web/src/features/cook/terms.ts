/**
 * Suchbegriffe aus Produktnamen und die Such-Links zu Cookidoo und Chefkoch (docs/plan-0.6.md, 1).
 * Reine Logik ohne React: Die App baut alles selbst, auch offline.
 *
 * Aus „Barilla Spaghetti n.5 500g" wird „Spaghetti": Es fallen weg die Wörter der Marke, der Text
 * der Packungsgröße, Mengen und Nummern („500 g", „2x400ml", „3,8 % Fett", „Nr. 5", „Type 405"),
 * Klammern samt Inhalt, ®, ™, ©, Anführungszeichen und Füllwörter („Bio", „Original" …). Ab der
 * ersten Präposition („in", „mit" …) wird gekürzt, wenn davor etwas bleibt. Ein Begriff hat höchstens
 * vier Wörter und 40 Zeichen; bleibt nichts, gilt der so gekürzte Name.
 *
 * Links gehen nur an zwei feste Rechner, auch mit Suchbegriffen aus Claudes Antworten: Jedes Wort
 * besteht dort nur aus Buchstaben, Ziffern und Bindestrichen und ist kodiert.
 */
import type { Product } from "@/contract";
import { foldText } from "@/features/stock/model";

/** Höchstens so viele Wörter hat ein Suchbegriff … */
export const TERM_MAX_WORDS = 4;
/** … und höchstens so viele Zeichen. */
export const TERM_MAX_CHARS = 40;

/** Wörter, die nichts über die Zutat sagen (in der Form von `foldText`). */
const FILLERS: ReadonlySet<string> = new Set(
  [
    "bio",
    "öko",
    "oko",
    "oeko",
    "original",
    "originale",
    "classic",
    "classico",
    "klassisch",
    "klassische",
    "klassischer",
    "klassisches",
    "premium",
    "gourmet",
    "delikatess",
    "neu",
    "new",
    "family",
    "familienpackung",
    "vorteilspack",
    "vorteilspackung",
    "großpackung",
    "sparpack",
  ].map(foldText),
);

/** Präpositionen, ab denen der Rest nur noch beschreibt („Thunfisch in eigenem Saft"). */
const PREPOSITIONS: ReadonlySet<string> = new Set(["aus", "mit", "in", "im", "ohne", "für"].map(foldText));

/** Einheiten nach einer Zahl: „500 g", „1,5 l", „6 Stück", „10er". */
const UNITS = "(?:g|gr|gramm|kg|mg|ml|cl|dl|l|ltr|liter|oz|lb|st|stk|stück|stck|er|pck|pack|packung|packungen|beutel|dose|dosen|glas|gläser|scheiben?|portionen?)";
const NUMBER = "\\d+(?:[.,]\\d+)?";

/** Mengen und Nummern, die aus dem Namen fallen. Die Reihenfolge zählt: erst die längeren Muster. */
const PATTERNS: readonly RegExp[] = [
  // 2x400ml, 6 x 1,5 l, 4×125 g
  new RegExp(`(?<![\\p{L}\\d])${NUMBER}\\s*[x×]\\s*${NUMBER}\\s*${UNITS}?(?![\\p{L}\\d])`, "giu"),
  // 3,8 % Fett, 1,5% fettarm bleibt fettarm
  new RegExp(`(?<![\\p{L}\\d])${NUMBER}\\s*(?:%|prozent)(?:\\s*fett(?![\\p{L}]))?`, "giu"),
  // 500 g, 500g, 1,5 l, 6 Stück, 10er
  new RegExp(`(?<![\\p{L}\\d])${NUMBER}\\s*${UNITS}(?![\\p{L}\\d])`, "giu"),
  // Nr. 5, No 7, N° 5, n.5, Type 405, Typ 550
  /(?<![\p{L}\d])(?:nr|no|n°|n|typ|type)\.?\s*\d+(?![\p{L}\d])/giu,
  // alles, was sonst an Zahlen übrig bleibt
  /(?<![\p{L}\d])\d+(?:[.,]\d+)?(?![\p{L}\d])/gu,
];

/** Klammern samt Inhalt, Marken- und Urheberzeichen, Anführungszeichen (das Apostroph ’ bleibt: „Omi’s"). */
const BRACKETS = /\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g;
const MARKS = /[®™©℗"„“”‚‘«»‹›]/g;

/** Ein Wort ohne Satzzeichen am Rand: „ja!" wird „ja", „-Pack" wird „Pack". */
function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Die Zeichen eines Texts für einen regulären Ausdruck, Leerraum beliebig breit. */
function escaped(text: string): string {
  return text
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");
}

/** Kürzt Wörter auf die Grenzen eines Begriffs: höchstens vier, zusammen höchstens 40 Zeichen. */
function limit(words: readonly string[]): string {
  const kept = words.slice(0, TERM_MAX_WORDS);
  while (kept.length > 1 && kept.join(" ").length > TERM_MAX_CHARS) {
    kept.pop();
  }
  return Array.from(kept.join(" ")).slice(0, TERM_MAX_CHARS).join("").trim();
}

/**
 * Der Suchbegriff für ein Produkt, etwa „Spaghetti" für „Barilla Spaghetti n.5 500g". Leer für
 * Platzhalter ohne Namen: Die sind keine Zutat.
 */
export function searchTerm(product: Pick<Product, "name" | "brand" | "quantity">): string {
  const name = product.name.replace(/\s+/g, " ").trim();
  if (name === "") {
    return "";
  }
  let text = name.replace(BRACKETS, " ").replace(MARKS, " ");
  const quantity = product.quantity.trim();
  if (quantity !== "") {
    text = text.replace(new RegExp(`(?<![\\p{L}\\d])${escaped(quantity)}(?![\\p{L}\\d])`, "giu"), " ");
  }
  for (const pattern of PATTERNS) {
    text = text.replace(pattern, " ");
  }
  const brand = new Set(
    product.brand
      .split(/\s+/)
      .map((word) => foldText(bare(word)))
      .filter((word) => /\p{L}/u.test(word)),
  );
  const words = text
    .split(/[\s,;:/|+&]+/)
    .map(bare)
    .filter((word) => word !== "" && /\p{L}/u.test(word))
    .filter((word) => !brand.has(foldText(word)) && !FILLERS.has(foldText(word)));
  // Ab der ersten Präposition nur noch Beschreibung, sofern davor etwas steht.
  const cut = words.findIndex((word, index) => index > 0 && PREPOSITIONS.has(foldText(word)));
  const term = limit(cut === -1 ? words : words.slice(0, cut));
  return term !== "" ? term : limit(name.split(" "));
}

/** Die Wörter der Begriffe für eine Suche: nur Buchstaben, Ziffern und Bindestriche, ohne leere. */
export function searchWords(terms: readonly string[]): string[] {
  return terms
    .flatMap((term) => term.replace(/[^\p{L}\p{N}-]+/gu, " ").split(" "))
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word !== "");
}

/** Die Suche bei Cookidoo (Thermomix) nach allen Begriffen; null ohne ein Wort. */
export function cookidooUrl(terms: readonly string[]): string | null {
  const words = searchWords(terms);
  return words.length === 0 ? null : `https://cookidoo.de/search/de-DE?query=${encodeURIComponent(words.join(" "))}`;
}

/** Die Suche bei Chefkoch nach allen Wörtern aller Begriffe; null ohne ein Wort. */
export function chefkochUrl(terms: readonly string[]): string | null {
  const words = searchWords(terms);
  return words.length === 0 ? null : `https://www.chefkoch.de/rs/s0/${words.map(encodeURIComponent).join("+")}/Rezepte.html`;
}
