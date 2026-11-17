import { useEffect, useRef, useState } from "react";

import { formatDate } from "@/contract";
import { relativeDays } from "@/ui";
import { Button, cx, Dialog, dialogFocus, IconButton, TextField } from "@/ui/base";
import { CloseIcon, PlusIcon } from "@/ui/icons";

import styles from "./CookPage.module.css";
import { matchCandidates, MAX_INGREDIENTS, type Candidate, type Ingredient } from "./model";
import { TERM_MAX_CHARS } from "./terms";

/** Wann eine Zutat abläuft, kurz für den Chip: „in 4 Tagen", „abgelaufen"; leer, wenn es nicht drängt. */
export function chipWhen(candidate: Pick<Candidate, "state" | "days">): string {
  if (candidate.days === null) {
    return "";
  }
  if (candidate.state === "expired") {
    return "abgelaufen";
  }
  return candidate.state === "soon" ? relativeDays(candidate.days) : "";
}

/** Was eine Zutat in der Auswahl unter ihrem Begriff zeigt: Name, Marke und Größe, MHD. */
function describe(candidate: Candidate): string {
  const name = [candidate.title, candidate.subtitle].filter((part) => part !== "").join(" · ");
  const more = candidate.product_ids.length > 1 ? ` und ${String(candidate.product_ids.length - 1)} weitere` : "";
  const when = candidate.best_before === null ? "ohne MHD" : `MHD ${formatDate(candidate.best_before)}`;
  return `${name}${more} · ${when}`;
}

interface ChipProps {
  ingredient: Ingredient;
  onTerm: (term: string) => void;
  onRemove: () => void;
}

/** Eine gewählte Zutat: der Suchbegriff; ein Tipp öffnet das Feld zum Ändern, ✕ nimmt sie heraus. */
function Chip({ ingredient, onTerm, onRemove }: ChipProps) {
  const { candidate, term } = ingredient;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(term);
  const input = useRef<HTMLInputElement>(null);
  const termButton = useRef<HTMLButtonElement>(null);
  /** Das Feld schließt schon (Enter, Escape): Ein Verlust des Fokus danach ändert nichts mehr. */
  const closing = useRef(false);
  const when = chipWhen(candidate);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  function finish(commit: boolean) {
    if (closing.current) {
      return;
    }
    closing.current = true;
    if (commit) {
      // Leer heißt: zurück zum abgeleiteten Begriff.
      onTerm(text.trim() === "" ? candidate.term : text.replace(/\s+/g, " ").trim());
    }
    setEditing(false);
    // Der Fokus geht zurück an den Chip, sobald er wieder da ist.
    setTimeout(() => termButton.current?.focus(), 0);
  }

  if (editing) {
    return (
      <li className={styles.chipEdit}>
        <TextField
          ref={input}
          label={`Suchbegriff für ${candidate.title}`}
          hideLabel
          value={text}
          maxLength={TERM_MAX_CHARS}
          autoComplete="off"
          enterKeyHint="done"
          onChange={(event) => setText(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              finish(false);
            }
          }}
        />
      </li>
    );
  }

  return (
    <li className={cx(styles.chip, candidate.state === "soon" && styles.soon, candidate.state === "expired" && styles.expired)}>
      <button
        ref={termButton}
        type="button"
        className={styles.chipTerm}
        aria-label={`Suchbegriff ändern: ${term}${when !== "" ? `, ${when}` : ""}`}
        title={describe(candidate)}
        onClick={() => {
          setText(term);
          closing.current = false;
          setEditing(true);
        }}
      >
        <span>{term}</span>
        {when !== "" ? <span className={styles.chipWhen}>{when}</span> : null}
      </button>
      <IconButton label={`Entfernen: ${term}`} size="sm" onClick={onRemove}>
        <CloseIcon />
      </IconButton>
    </li>
  );
}

interface PickerProps {
  open: boolean;
  onClose: () => void;
  candidates: readonly Candidate[];
  onPick: (candidate: Candidate) => void;
}

/** „Zutat hinzufügen": die übrigen Kandidaten aus dem Vorrat, mit Suche. */
function Picker({ open, onClose, candidates, onPick }: PickerProps) {
  const [query, setQuery] = useState("");
  const shown = matchCandidates(candidates, query);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="Zutat hinzufügen" variant="sheet">
      <div className={styles.picker}>
        <TextField ref={dialogFocus} label="Im Vorrat suchen" type="search" autoComplete="off" enterKeyHint="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        {shown.length === 0 ? (
          <p className={styles.muted}>{candidates.length === 0 ? "Alles aus dem Vorrat ist schon gewählt." : "Nichts im Vorrat passt dazu."}</p>
        ) : (
          <ul className={styles.options} aria-label="Zutaten aus dem Vorrat">
            {shown.map((candidate) => (
              <li key={candidate.key}>
                <button type="button" className={styles.option} onClick={() => onPick(candidate)}>
                  <span className={styles.optionTerm}>{candidate.term}</span>
                  <span className={styles.small}>{describe(candidate)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export interface IngredientsProps {
  ingredients: readonly Ingredient[];
  /** Alle Kandidaten aus dem Vorrat, in ihrer Reihenfolge. */
  candidates: readonly Candidate[];
  onChange: (ingredients: Ingredient[]) => void;
}

/**
 * Die gewählten Zutaten als Chips mit ihrem Suchbegriff. Ein Tipp ändert den Begriff (nur hier, für
 * diese Seite), ✕ nimmt die Zutat heraus, „Zutat" holt eine weitere aus dem Vorrat dazu, höchstens
 * `MAX_INGREDIENTS`.
 */
export function Ingredients({ ingredients, candidates, onChange }: IngredientsProps) {
  const [picking, setPicking] = useState(false);
  const chosen = new Set(ingredients.map((ingredient) => ingredient.candidate.key));
  const rest = candidates.filter((candidate) => !chosen.has(candidate.key));
  const full = ingredients.length >= MAX_INGREDIENTS;

  return (
    <div>
      <ul className={styles.chips} aria-label="Gewählte Zutaten">
        {ingredients.map((ingredient, index) => (
          <Chip
            key={ingredient.candidate.key}
            ingredient={ingredient}
            onTerm={(term) => onChange(ingredients.map((entry, at) => (at === index ? { ...entry, term } : entry)))}
            onRemove={() => onChange(ingredients.filter((_, at) => at !== index))}
          />
        ))}
        <li>
          <Button size="sm" variant="ghost" icon={<PlusIcon />} aria-label="Zutat hinzufügen" disabled={full || rest.length === 0} onClick={() => setPicking(true)}>
            Zutat
          </Button>
        </li>
      </ul>
      <p className={cx(styles.small, styles.ingredientsFoot)}>
        {ingredients.length === 0
          ? "Keine Zutat gewählt. Mit „Zutat“ eine aus dem Vorrat nehmen."
          : full
            ? `Höchstens ${String(MAX_INGREDIENTS)} Zutaten. Ein Tipp auf eine Zutat ändert den Suchbegriff.`
            : "Ein Tipp auf eine Zutat ändert den Suchbegriff; das gilt nur hier."}
      </p>
      <Picker
        open={picking}
        onClose={() => setPicking(false)}
        candidates={rest}
        onPick={(candidate) => {
          onChange([...ingredients, { candidate, term: candidate.term }]);
          setPicking(false);
        }}
      />
    </div>
  );
}
