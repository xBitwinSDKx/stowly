/**
 * Prüfungen für Schaltflächen in Tests, auch in denen der Scan-Ansichten. Nur aus Tests und
 * test-setup.ts importieren: Der Import richtet die Prüfungen ein.
 *
 *   expect(button).toBeUnavailable()   ein Klick löst gerade nichts aus
 *   expect(button).toBeAvailable()     ein Klick löst etwas aus
 *
 * Sie ersetzen `toBeDisabled()` und `toBeEnabled()`: Eine Schaltfläche, die arbeitet (`busy`) oder
 * gesperrt wird, während sie den Fokus hat, trägt statt `disabled` nur `aria-disabled="true"`
 * (siehe `useButtonLock`). Für `toBeDisabled()` wäre sie frei.
 */
import { expect } from "vitest";

/** Gesperrt: `disabled` (auch über ein gesperrtes fieldset) oder `aria-disabled="true"`. */
function isUnavailable(element: Element): boolean {
  return element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
}

function element(received: unknown, matcher: string): Element {
  if (typeof Element === "undefined" || !(received instanceof Element)) {
    throw new TypeError(`${matcher}() erwartet ein Element, bekommen hat es: ${String(received)}`);
  }
  return received;
}

/** Die Schaltfläche in der Meldung: Art und Beschriftung. */
function named(target: Element): string {
  const name = target.getAttribute("aria-label") ?? target.textContent?.trim() ?? "";
  return `<${target.tagName.toLowerCase()}>${name === "" ? "" : ` „${name}“`}`;
}

/** Woran die Sperre hängt, für die Meldung. */
function lockOf(target: Element): string {
  const parts: string[] = [];
  if (target.matches(":disabled")) {
    parts.push("disabled");
  }
  const aria = target.getAttribute("aria-disabled");
  if (aria !== null) {
    parts.push(`aria-disabled="${aria}"`);
  }
  return parts.length === 0 ? "ohne Sperre" : parts.join(", ");
}

expect.extend({
  toBeUnavailable(received: unknown) {
    const target = element(received, "toBeUnavailable");
    const pass = isUnavailable(target);
    return {
      pass,
      message: () =>
        pass
          ? `${named(target)} sollte bedienbar sein, ist aber gesperrt (${lockOf(target)}).`
          : `${named(target)} sollte gesperrt sein (disabled oder aria-disabled="true"), ist aber bedienbar (${lockOf(target)}).`,
    };
  },
  toBeAvailable(received: unknown) {
    const target = element(received, "toBeAvailable");
    const pass = !isUnavailable(target);
    return {
      pass,
      message: () =>
        pass
          ? `${named(target)} sollte gesperrt sein (disabled oder aria-disabled="true"), ist aber bedienbar (${lockOf(target)}).`
          : `${named(target)} sollte bedienbar sein, ist aber gesperrt (${lockOf(target)}).`,
    };
  },
});

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    /** Ein Klick löst gerade nichts aus: `disabled` oder `aria-disabled="true"`. */
    toBeUnavailable: () => R;
    /** Ein Klick löst etwas aus: weder `disabled` noch `aria-disabled="true"`. */
    toBeAvailable: () => R;
  }
}
