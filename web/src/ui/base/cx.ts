/** Fügt Klassennamen zusammen und lässt alles Leere weg. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
