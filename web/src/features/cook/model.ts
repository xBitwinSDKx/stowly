/**
 * Zutaten für „Was koche ich?" (docs/plan-0.6.md, 1): reine Logik ohne React, offline aus dem Bestand.
 *
 * Kandidat ist jedes Produkt im Bestand mit Namen (Platzhalter nicht), zusammengefasst je Produkt wie
 * in der Bestandsliste (`groupByProduct`), mit seinem kritischsten MHD. Reihenfolge: was bald abläuft,
 * nach Tagen; was abgelaufen ist, das zuletzt abgelaufene zuerst; der Rest nach MHD; zuletzt alles ohne
 * MHD nach Namen. Produkte mit demselben Suchbegriff sind ein Kandidat („Spaghetti" zweier Marken).
 *
 * Vorgewählt sind zwei bis drei Kandidaten: alle, die bald ablaufen oder abgelaufen sind, höchstens
 * drei, und mindestens zwei, notfalls mit dem nächsten MHD. Eine Adresse mit `?mit=` wählt stattdessen
 * genau ihre Produkte vor.
 */
import { COOK_WITH_PARAM, isPlaceholder, LIMITS, type ExpiryState } from "@/contract";
import { foldText, type ProductGroup } from "@/features/stock/model";

import { searchTerm } from "./terms";

/** So viele Zutaten sind mindestens vorgewählt, wenn es so viele gibt … */
export const PRESELECT_MIN = 2;
/** … und höchstens. */
export const PRESELECT_MAX = 3;
/** Höchstens so viele Zutaten lassen sich wählen: so viele gehen an Claude (`LIMITS.cook_focus`). */
export const MAX_INGREDIENTS = LIMITS.cook_focus;

/** Ein Kandidat für die Zutaten: ein Suchbegriff mit den Produkten dahinter. */
export interface Candidate {
  /** Eindeutig: die Kennung des ersten (dringendsten) Produkts. */
  key: string;
  /** Der abgeleitete Suchbegriff (`searchTerm`). */
  term: string;
  /** Die Produkte mit diesem Begriff, das dringendste zuerst. */
  product_ids: string[];
  /** Anzeigename und Zeile darunter des ersten Produkts, wie in der Bestandsliste. */
  title: string;
  subtitle: string;
  /** Das kritischste MHD des ersten Produkts mit Warnstufe und Tagen. */
  best_before: string | null;
  state: ExpiryState;
  days: number | null;
}

/** Eine gewählte Zutat: ein Kandidat mit dem Begriff, wie er gerade auf der Seite steht. */
export interface Ingredient {
  candidate: Candidate;
  /** Der Suchbegriff; auf der Seite änderbar. */
  term: string;
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/** Rang der Warnstufen in der Reihenfolge der Kandidaten. */
const RANK: Record<ExpiryState, number> = { soon: 0, expired: 1, ok: 2, none: 3 };

/** Ist der Kandidat dringend (läuft bald ab oder ist abgelaufen)? */
export function isUrgent(candidate: Pick<Candidate, "state">): boolean {
  return candidate.state === "soon" || candidate.state === "expired";
}

function compareGroups(a: ProductGroup, b: ProductGroup): number {
  const byState = RANK[a.state] - RANK[b.state];
  if (byState !== 0) {
    return byState;
  }
  const daysA = a.days ?? 0;
  const daysB = b.days ?? 0;
  // Abgelaufen: das zuletzt abgelaufene zuerst (−1 vor −10); sonst das nächste MHD zuerst.
  const byDays = a.state === "expired" ? daysB - daysA : daysA - daysB;
  return byDays || collator.compare(a.title, b.title) || (a.product_id < b.product_id ? -1 : 1);
}

/**
 * Die Kandidaten aus dem Bestand je Produkt (`groupByProduct`), in der Reihenfolge der Seite; gleiche
 * Begriffe zusammengelegt.
 */
export function cookCandidates(groups: readonly ProductGroup[]): Candidate[] {
  const sorted = groups.filter((group) => group.product !== undefined && !isPlaceholder(group.product)).sort(compareGroups);
  const byTerm = new Map<string, Candidate>();
  const result: Candidate[] = [];
  for (const group of sorted) {
    const product = group.product;
    if (!product) {
      continue;
    }
    const term = searchTerm(product);
    if (term === "") {
      continue;
    }
    const folded = foldText(term);
    const known = byTerm.get(folded);
    if (known) {
      known.product_ids.push(group.product_id);
      continue;
    }
    const candidate: Candidate = {
      key: group.product_id,
      term,
      product_ids: [group.product_id],
      title: group.title,
      subtitle: group.subtitle,
      best_before: group.critical,
      state: group.state,
      days: group.days,
    };
    byTerm.set(folded, candidate);
    result.push(candidate);
  }
  return result;
}

/** Die Kennungen aus `?mit=`, in ihrer Reihenfolge, ohne Doppelte (mehrere mit Komma oder wiederholt). */
export function requestedIds(search: string): string[] {
  const params = new URLSearchParams(search);
  const ids = params
    .getAll(COOK_WITH_PARAM)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return [...new Set(ids)];
}

/**
 * Die vorgewählten Kandidaten. Mit Kennungen aus `?mit=` genau die Kandidaten dieser Produkte (in
 * ihrer Reihenfolge, höchstens `MAX_INGREDIENTS`); passt keine, gilt die Vorwahl ohne sie.
 */
export function preselect(candidates: readonly Candidate[], requested: readonly string[] = []): Candidate[] {
  if (requested.length > 0) {
    const chosen: Candidate[] = [];
    for (const id of requested) {
      const found = candidates.find((candidate) => candidate.product_ids.includes(id));
      if (found && !chosen.includes(found)) {
        chosen.push(found);
      }
    }
    if (chosen.length > 0) {
      return chosen.slice(0, MAX_INGREDIENTS);
    }
  }
  const urgent = candidates.filter(isUrgent).length;
  return candidates.slice(0, Math.min(PRESELECT_MAX, Math.max(PRESELECT_MIN, urgent)));
}

/** Die Begriffe der gewählten Zutaten für die Such-Links, ohne leere. */
export function ingredientTerms(ingredients: readonly Ingredient[]): string[] {
  return ingredients.map((ingredient) => ingredient.term.trim()).filter((term) => term !== "");
}

/** Die Produkte, auf die Claude setzen soll: je Zutat das erste Produkt, höchstens `LIMITS.cook_focus`. */
export function focusIds(ingredients: readonly Ingredient[]): string[] {
  return [...new Set(ingredients.map((ingredient) => ingredient.candidate.product_ids[0]).filter((id): id is string => id !== undefined))].slice(0, LIMITS.cook_focus);
}

/** Kandidaten, die zur Eingabe der Suche passen: jedes Wort im Begriff, im Namen oder in der Zeile darunter. */
export function matchCandidates(candidates: readonly Candidate[], query: string): Candidate[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "")
    .map(foldText);
  if (words.length === 0) {
    return [...candidates];
  }
  return candidates.filter((candidate) => {
    const haystack = foldText(`${candidate.term} ${candidate.title} ${candidate.subtitle}`);
    return words.every((word) => haystack.includes(word));
  });
}
