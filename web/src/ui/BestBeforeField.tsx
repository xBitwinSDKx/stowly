import { useState, type Ref } from "react";

import { daysBetween, formatDate, parseBestBefore } from "@/contract";

import { IconButton, TextField } from "./base";
import { relativeDays } from "./format";
import { CloseIcon } from "./icons";

/** Was in einem MHD-Feld steht. */
export type BestBeforeInput =
  /** Leer: kein MHD. */
  | { kind: "empty" }
  /** Als Datum verstanden. */
  | { kind: "date"; date: string; precision: "day" | "month" }
  /** Etwas eingegeben, aber kein Datum. */
  | { kind: "invalid" };

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** Liest den Text eines MHD-Felds mit der gemeinsamen Regel `parseBestBefore`. */
export function readBestBefore(text: string, today: string): BestBeforeInput {
  if (text.trim() === "") {
    return { kind: "empty" };
  }
  const parsed = parseBestBefore(text, today);
  return parsed ? { kind: "date", date: parsed.date, precision: parsed.precision } : { kind: "invalid" };
}

/** Der Satz unter dem Feld: welches Datum verstanden wurde. */
export function describeBestBefore(input: BestBeforeInput, today: string): string | null {
  if (input.kind !== "date") {
    return null;
  }
  const days = daysBetween(today, input.date);
  const month = MONTHS[Number(input.date.slice(5, 7)) - 1] ?? "";
  const when = input.precision === "month" ? `${formatDate(input.date)} (Ende ${month} ${input.date.slice(0, 4)})` : formatDate(input.date);
  return `Verstanden: ${when} · ${relativeDays(days)}`;
}

export const BEST_BEFORE_EXAMPLES = "25.03.27, 2503 oder 03/27";

export interface BestBeforeFieldProps {
  /** Vorgabe „MHD". */
  label?: string;
  /** Der Text im Feld. Was er bedeutet, sagt `readBestBefore(value, today)`. */
  value: string;
  onChange: (value: string) => void;
  /** Heute als "YYYY-MM-DD" (`useToday()`). */
  today: string;
  /** Hinweis bei leerem Feld. Vorgabe: „Leer lassen = kein MHD". */
  emptyHint?: string;
  /** Fehler auch zeigen, bevor das Feld verlassen wurde (nach einem Speicherversuch). */
  showError?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * Schnelle Eingabe des MHD. Zeigt beim Tippen, welches Datum verstanden wurde:
 * „0327" wird zu „31.03.2027 (Ende März 2027)". Am Handy erscheint der Ziffernblock.
 */
export function BestBeforeField({
  label = "MHD",
  value,
  onChange,
  today,
  emptyHint = "Leer lassen = kein MHD",
  showError = false,
  autoFocus,
  disabled,
  className,
  ref,
}: BestBeforeFieldProps) {
  const [left, setLeft] = useState(false);
  const input = readBestBefore(value, today);
  const understood = describeBestBefore(input, today);

  let hint: string;
  let error: string | null = null;
  if (input.kind === "empty") {
    hint = emptyHint;
  } else if (understood !== null) {
    hint = understood;
  } else {
    hint = `Noch kein Datum erkannt. Beispiele: ${BEST_BEFORE_EXAMPLES}`;
    if (left || showError) {
      error = `Kein Datum erkannt. Beispiele: ${BEST_BEFORE_EXAMPLES}`;
    }
  }

  return (
    <TextField
      ref={ref}
      className={className}
      label={label}
      value={value}
      inputMode="numeric"
      autoComplete="off"
      enterKeyHint="done"
      placeholder="TT.MM.JJ oder MM.JJ"
      maxLength={24}
      autoFocus={autoFocus}
      disabled={disabled}
      hint={hint}
      error={error}
      onChange={(event) => {
        setLeft(false);
        onChange(event.target.value);
      }}
      onBlur={() => setLeft(true)}
      trailing={
        value !== "" && !disabled ? (
          <IconButton label="MHD leeren" size="sm" onClick={() => onChange("")}>
            <CloseIcon />
          </IconButton>
        ) : undefined
      }
    />
  );
}
